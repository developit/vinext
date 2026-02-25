/**
 * App Router dev server handler.
 *
 * This module generates virtual entry points for the server and browser
 * environments. The server entry does route matching, renders the Preact
 * component tree directly to HTML using preact-render-to-string, and
 * returns a full HTML document response.
 */
import fs from "node:fs";
import type { AppRoute } from "../routing/app-router.js";
import type { MetadataFileRoute } from "./metadata-routes.js";
import type { NextRedirect, NextRewrite, NextHeader } from "../config/next-config.js";

/**
 * Resolved config options relevant to App Router request handling.
 * Passed from the Vite plugin where the full next.config.js is loaded.
 */
export interface AppRouterConfig {
  redirects?: NextRedirect[];
  rewrites?: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers?: NextHeader[];
  /** Extra origins allowed for server action CSRF checks (from experimental.serverActions.allowedOrigins). */
  allowedOrigins?: string[];
}

/**
 * Generate the virtual server entry module.
 *
 * This runs in the server Vite environment. It matches the incoming
 * request URL to an app route, builds the nested layout + page tree,
 * and renders it directly to HTML using Preact and preact-render-to-string.
 */
export function generateRscEntry(
  appDir: string,
  routes: AppRoute[],
  middlewarePath?: string | null,
  metadataRoutes?: MetadataFileRoute[],
  globalErrorPath?: string | null,
  basePath?: string,
  trailingSlash?: boolean,
  config?: AppRouterConfig,
): string {
  const bp = basePath ?? "";
  const ts = trailingSlash ?? false;
  const redirects = config?.redirects ?? [];
  const rewrites = config?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
  const headers = config?.headers ?? [];
  const allowedOrigins = config?.allowedOrigins ?? [];
  // Build import map for all page and layout files
  const imports: string[] = [];
  const importMap: Map<string, string> = new Map();
  let importIdx = 0;

  function getImportVar(filePath: string): string {
    if (importMap.has(filePath)) return importMap.get(filePath)!;
    const varName = `mod_${importIdx++}`;
    const absPath = filePath.replace(/\\/g, "/");
    imports.push(`import * as ${varName} from ${JSON.stringify(absPath)};`);
    importMap.set(filePath, varName);
    return varName;
  }

  // Pre-register all modules
  for (const route of routes) {
    if (route.pagePath) getImportVar(route.pagePath);
    if (route.routePath) getImportVar(route.routePath);
    for (const layout of route.layouts) getImportVar(layout);
    for (const tmpl of route.templates) getImportVar(tmpl);
    if (route.loadingPath) getImportVar(route.loadingPath);
    if (route.errorPath) getImportVar(route.errorPath);
    if (route.layoutErrorPaths) for (const ep of route.layoutErrorPaths) { if (ep) getImportVar(ep); }
    if (route.notFoundPath) getImportVar(route.notFoundPath);
    for (const nfp of route.notFoundPaths || []) { if (nfp) getImportVar(nfp); }
    if (route.forbiddenPath) getImportVar(route.forbiddenPath);
    if (route.unauthorizedPath) getImportVar(route.unauthorizedPath);
    // Register parallel slot modules
    for (const slot of route.parallelSlots) {
      if (slot.pagePath) getImportVar(slot.pagePath);
      if (slot.defaultPath) getImportVar(slot.defaultPath);
      if (slot.layoutPath) getImportVar(slot.layoutPath);
      if (slot.loadingPath) getImportVar(slot.loadingPath);
      if (slot.errorPath) getImportVar(slot.errorPath);
      // Register intercepting route page modules
      for (const ir of slot.interceptingRoutes) {
        getImportVar(ir.pagePath);
      }
    }
  }

  // Build route table as serialized JS
  const routeEntries = routes.map((route) => {
    const layoutVars = route.layouts.map((l) => getImportVar(l));
    const templateVars = route.templates.map((t) => getImportVar(t));
    const notFoundVars = (route.notFoundPaths || []).map((nf) => nf ? getImportVar(nf) : "null");
    const slotEntries = route.parallelSlots.map((slot) => {
      const interceptEntries = slot.interceptingRoutes.map((ir) => {
        return `        {
          convention: ${JSON.stringify(ir.convention)},
          targetPattern: ${JSON.stringify(ir.targetPattern)},
          page: ${getImportVar(ir.pagePath)},
          params: ${JSON.stringify(ir.params)},
        }`;
      });
      return `      ${JSON.stringify(slot.name)}: {
        page: ${slot.pagePath ? getImportVar(slot.pagePath) : "null"},
        default: ${slot.defaultPath ? getImportVar(slot.defaultPath) : "null"},
        layout: ${slot.layoutPath ? getImportVar(slot.layoutPath) : "null"},
        loading: ${slot.loadingPath ? getImportVar(slot.loadingPath) : "null"},
        error: ${slot.errorPath ? getImportVar(slot.errorPath) : "null"},
        layoutIndex: ${slot.layoutIndex},
        intercepts: [
${interceptEntries.join(",\n")}
        ],
      }`;
    });
    const layoutErrorVars = (route.layoutErrorPaths || []).map((ep) => ep ? getImportVar(ep) : "null");
    return `  {
    pattern: ${JSON.stringify(route.pattern)},
    isDynamic: ${route.isDynamic},
    params: ${JSON.stringify(route.params)},
    page: ${route.pagePath ? getImportVar(route.pagePath) : "null"},
    routeHandler: ${route.routePath ? getImportVar(route.routePath) : "null"},
    layouts: [${layoutVars.join(", ")}],
    layoutSegmentDepths: ${JSON.stringify(route.layoutSegmentDepths)},
    templates: [${templateVars.join(", ")}],
    errors: [${layoutErrorVars.join(", ")}],
    slots: {
${slotEntries.join(",\n")}
    },
    loading: ${route.loadingPath ? getImportVar(route.loadingPath) : "null"},
    error: ${route.errorPath ? getImportVar(route.errorPath) : "null"},
    notFound: ${route.notFoundPath ? getImportVar(route.notFoundPath) : "null"},
    notFounds: [${notFoundVars.join(", ")}],
    forbidden: ${route.forbiddenPath ? getImportVar(route.forbiddenPath) : "null"},
    unauthorized: ${route.unauthorizedPath ? getImportVar(route.unauthorizedPath) : "null"},
  }`;
  });

  // Find root not-found/forbidden/unauthorized pages and root layouts for global error handling
  const rootRoute = routes.find((r) => r.pattern === "/");
  const rootNotFoundVar = rootRoute?.notFoundPath
    ? getImportVar(rootRoute.notFoundPath)
    : null;
  const rootForbiddenVar = rootRoute?.forbiddenPath
    ? getImportVar(rootRoute.forbiddenPath)
    : null;
  const rootUnauthorizedVar = rootRoute?.unauthorizedPath
    ? getImportVar(rootRoute.unauthorizedPath)
    : null;
  const rootLayoutVars = rootRoute
    ? rootRoute.layouts.map((l) => getImportVar(l))
    : [];

  // Global error boundary (app/global-error.tsx)
  const globalErrorVar = globalErrorPath ? getImportVar(globalErrorPath) : null;

  // Build metadata route handling
  const effectiveMetaRoutes = metadataRoutes ?? [];
  const dynamicMetaRoutes = effectiveMetaRoutes.filter((r) => r.isDynamic);

  // Import dynamic metadata modules
  for (const mr of dynamicMetaRoutes) {
    getImportVar(mr.filePath);
  }

  // Build metadata route table
  // For static metadata files, read the file content at code-generation time
  // and embed it as base64. This ensures static metadata files work on runtimes
  // without filesystem access (e.g., Cloudflare Workers).
  const metaRouteEntries = effectiveMetaRoutes.map((mr) => {
    if (mr.isDynamic) {
      return `  {
    type: ${JSON.stringify(mr.type)},
    isDynamic: true,
    servedUrl: ${JSON.stringify(mr.servedUrl)},
    contentType: ${JSON.stringify(mr.contentType)},
    module: ${getImportVar(mr.filePath)},
  }`;
    }
    // Static: read file and embed as base64
    let fileDataBase64 = "";
    try {
      const buf = fs.readFileSync(mr.filePath);
      fileDataBase64 = buf.toString("base64");
    } catch {
      // File unreadable — will serve empty response at runtime
    }
    return `  {
    type: ${JSON.stringify(mr.type)},
    isDynamic: false,
    servedUrl: ${JSON.stringify(mr.servedUrl)},
    contentType: ${JSON.stringify(mr.contentType)},
    fileDataBase64: ${JSON.stringify(fileDataBase64)},
  }`;
  });

  return `
import { h, Fragment } from "preact";
import { Suspense } from "preact/compat";
import { renderToReadableStream } from "preact-render-to-string/stream";
import { setNavigationContext as _setNavigationContextOrig, getNavigationContext as _getNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, markDynamicUsage, runWithHeadersContext, applyMiddlewareRequestHeaders } from "next/headers";
import { NextRequest } from "next/server";
import { ErrorBoundary, NotFoundBoundary } from "vinext/error-boundary";
import { LayoutSegmentProvider } from "vinext/layout-segment-context";
import { MetadataHead, mergeMetadata, resolveModuleMetadata, ViewportHead, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${effectiveMetaRoutes.length > 0 ? `import { sitemapToXml, robotsToText, manifestToJson } from ${JSON.stringify(new URL("./metadata-routes.js", import.meta.url).pathname.replace(/\\/g, "/"))};` : ""}
import { _consumeRequestScopedCacheLife, _initRequestScopedCacheState } from "next/cache";
import { runWithFetchCache } from "vinext/fetch-cache";
import { safeJsonStringify } from "vinext/html";
import { clearPrivateCache as _clearPrivateCache } from "vinext/cache-runtime";
// Import server-only state module to register ALS-backed accessors.
import "vinext/navigation-state";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }
function _getSSRFontPreloads() { return [..._getSSRFontPreloadsGoogle(), ..._getSSRFontPreloadsLocal()]; }

function _escAttr(s) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

// Render a Preact element to a full HTML document string.
// Renders the component tree to HTML, then injects fonts, params, and the
// browser entry script before </head>.
async function _renderToFullHtml(element, opts) {
  const htmlStream = renderToReadableStream(element);
  await htmlStream.allReady;
  const bodyHtml = await new Response(htmlStream).text();

  const { fontData, navContext, serverInsertedHtml } = opts || {};
  let headHtml = "";

  if (fontData && fontData.links) {
    for (const url of fontData.links) {
      headHtml += '<link rel="stylesheet" href="' + _escAttr(url) + '" />\\n';
    }
  }
  if (fontData && fontData.preloads) {
    for (const preload of fontData.preloads) {
      headHtml += '<link rel="preload" href="' + _escAttr(preload.href) + '" as="font" type="' + _escAttr(preload.type) + '" crossorigin />\\n';
    }
  }
  if (fontData && fontData.styles && fontData.styles.length > 0) {
    headHtml += '<style data-vinext-fonts>' + fontData.styles.join("\\n") + '</style>\\n';
  }
  if (serverInsertedHtml) headHtml += serverInsertedHtml;

  headHtml += '<script>self.__VINEXT_RSC_PARAMS__=' + safeJsonStringify(navContext && navContext.params ? navContext.params : {}) + '</script>';
  // TODO: Browser entry script URL should be provided by the Vite plugin
  headHtml += '<script type="module" src="/@id/virtual:vinext-browser-entry"></script>';

  const headEnd = bodyHtml.indexOf("</head>");
  if (headEnd !== -1) {
    return bodyHtml.slice(0, headEnd) + headHtml + bodyHtml.slice(headEnd);
  }
  return bodyHtml + headHtml;
}

// Set navigation context in the ALS-backed store. "use client" components
// rendered during SSR need the pathname/searchParams/params but the SSR
// environment has a separate module instance of next/navigation.
// Use _getNavigationContext() to read the current context — never cache
// it in a module-level variable (that would leak between concurrent requests).
function setNavigationContext(ctx) {
  _setNavigationContextOrig(ctx);
}

// ISR cache is disabled in dev mode — every request re-renders fresh,
// matching Next.js dev behavior. Cache-Control headers are still emitted
// based on export const revalidate for testing purposes.
// Production ISR is handled by prod-server.ts and the Cloudflare worker entry.



${imports.join("\n")}

const routes = [
${routeEntries.join(",\n")}
];

const metadataRoutes = [
${metaRouteEntries.join(",\n")}
];

const rootNotFoundModule = ${rootNotFoundVar ? rootNotFoundVar : "null"};
const rootForbiddenModule = ${rootForbiddenVar ? rootForbiddenVar : "null"};
const rootUnauthorizedModule = ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"};
const rootLayouts = [${rootLayoutVars.join(", ")}];

/**
 * Render an HTTP access fallback page (not-found/forbidden/unauthorized) with layouts and noindex meta.
 * Returns null if no matching component is available.
 *
 * @param opts.boundaryComponent - Override the boundary component (for layout-level notFound)
 * @param opts.layouts - Override the layouts to wrap with (for layout-level notFound, excludes the throwing layout)
 */
async function renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request, opts) {
  // Determine which boundary component to use based on status code
  let BoundaryComponent = opts?.boundaryComponent ?? null;
  if (!BoundaryComponent) {
    let boundaryModule;
    if (statusCode === 403) {
      boundaryModule = route?.forbidden ?? rootForbiddenModule;
    } else if (statusCode === 401) {
      boundaryModule = route?.unauthorized ?? rootUnauthorizedModule;
    } else {
      boundaryModule = route?.notFound ?? rootNotFoundModule;
    }
    BoundaryComponent = boundaryModule?.default ?? null;
  }
  const layouts = opts?.layouts ?? route?.layouts ?? rootLayouts;
  if (!BoundaryComponent) return null;

  // Resolve metadata and viewport from parent layouts so that not-found/error
  // pages inherit title, description, OG tags etc. — matching Next.js behavior.
  const metadataList = [];
  const viewportList = [];
  for (const layoutMod of layouts) {
    if (layoutMod) {
      const meta = await resolveModuleMetadata(layoutMod);
      if (meta) metadataList.push(meta);
      const vp = await resolveModuleViewport(layoutMod);
      if (vp) viewportList.push(vp);
    }
  }
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;
  const resolvedViewport = viewportList.length > 0 ? mergeViewport(viewportList) : null;

  // Build element: metadata head + noindex meta + boundary component wrapped in layouts
  // Always include charset and default viewport for parity with Next.js.
  const charsetMeta = h("meta", { charSet: "utf-8" });
  const noindexMeta = h("meta", { name: "robots", content: "noindex" });
  const headElements = [charsetMeta, noindexMeta];
  if (resolvedMetadata) headElements.push(h(MetadataHead, { metadata: resolvedMetadata }));
  const effectiveViewport = resolvedViewport ?? { width: "device-width", initialScale: 1 };
  headElements.push(h(ViewportHead, { viewport: effectiveViewport }));
  let element = h(Fragment, null, ...headElements, h(BoundaryComponent));
  // Wrap with layouts (always include LayoutSegmentProvider for consistency)
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = h(LayoutComponent, { children: element });
      const layoutDepth = (route?.layoutSegmentDepths) ? route.layoutSegmentDepths[i] : 0;
      element = h(LayoutSegmentProvider, { depth: layoutDepth }, element);
    }
  }
  ${globalErrorVar ? `
  const _GlobalErrorComponent = ${globalErrorVar}.default;
  if (_GlobalErrorComponent) {
    element = h(ErrorBoundary, {
      fallback: _GlobalErrorComponent,
      children: element,
    });
  }
  ` : ""}
  // Render to HTML using Preact
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
    preloads: _getSSRFontPreloads(),
  };
  const fullHtml = await _renderToFullHtml(element, { fontData, navContext: _getNavigationContext() });
  setHeadersContext(null);
  setNavigationContext(null);
  const _respHeaders = { "Content-Type": "text/html; charset=utf-8" };
  const _linkParts = (fontData.preloads || []).map(function(p) { return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin"; });
  if (_linkParts.length > 0) _respHeaders["Link"] = _linkParts.join(", ");
  return new Response(fullHtml, {
    status: statusCode,
    headers: _respHeaders,
  });
}

/** Convenience: render a not-found page (404) */
async function renderNotFoundPage(route, isRscRequest, request) {
  return renderHTTPAccessFallbackPage(route, 404, isRscRequest, request);
}

/**
 * Render an error.tsx boundary page when a server component or generateMetadata() throws.
 * Returns null if no error boundary component is available for this route.
 *
 * Next.js returns HTTP 200 when error.tsx catches an error (the error is "handled"
 * by the boundary). This matches that behavior intentionally.
 */
async function renderErrorBoundaryPage(route, error, isRscRequest, request) {
  // Resolve the error boundary component: leaf error.tsx first, then walk per-layout
  // errors from innermost to outermost (matching ancestor inheritance), then global-error.tsx.
  let ErrorComponent = route?.error?.default ?? null;
  if (!ErrorComponent && route?.errors) {
    for (let i = route.errors.length - 1; i >= 0; i--) {
      if (route.errors[i]?.default) {
        ErrorComponent = route.errors[i].default;
        break;
      }
    }
  }
  ErrorComponent = ErrorComponent${globalErrorVar ? ` ?? ${globalErrorVar}?.default` : ""};
  if (!ErrorComponent) return null;

  const errorObj = error instanceof Error ? error : new Error(String(error));
  // Only pass error — reset is a client-side concern (re-renders the segment) and
  // can't be serialized to the client. The error.tsx component will receive reset=undefined
  // during SSR, which is fine — onClick={undefined} is harmless, and the real reset
  // function is only meaningful after hydration.
  let element = h(ErrorComponent, {
    error: errorObj,
  });
  const layouts = route?.layouts ?? rootLayouts;
  // Wrap with layouts (include LayoutSegmentProvider for consistency)
  const layoutDepths = route?.layoutSegmentDepths;
  for (let i = layouts.length - 1; i >= 0; i--) {
    const LayoutComponent = layouts[i]?.default;
    if (LayoutComponent) {
      element = h(LayoutComponent, { children: element });
      const layoutDepth = layoutDepths ? layoutDepths[i] : 0;
      element = h(LayoutSegmentProvider, { depth: layoutDepth }, element);
    }
  }
  ${globalErrorVar ? `
  const _ErrGlobalComponent = ${globalErrorVar}.default;
  if (_ErrGlobalComponent) {
    element = h(ErrorBoundary, {
      fallback: _ErrGlobalComponent,
      children: element,
    });
  }
  ` : ""}
  // Render to HTML using Preact
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
    preloads: _getSSRFontPreloads(),
  };
  const fullHtml = await _renderToFullHtml(element, { fontData, navContext: _getNavigationContext() });
  setHeadersContext(null);
  setNavigationContext(null);
  const _errHeaders = { "Content-Type": "text/html; charset=utf-8" };
  const _errLinkParts = (fontData.preloads || []).map(function(p) { return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin"; });
  if (_errLinkParts.length > 0) _errHeaders["Link"] = _errLinkParts.join(", ");
  return new Response(fullHtml, {
    status: 200,
    headers: _errHeaders,
  });
}

function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  try { normalizedUrl = decodeURIComponent(normalizedUrl); } catch {}
  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) return { route, params };
  }
  return null;
}

function matchPattern(url, pattern) {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = Object.create(null);
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.endsWith("+")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }
    if (pp.endsWith("*")) {
      const paramName = pp.slice(1, -1);
      params[paramName] = urlParts.slice(i);
      return params;
    }
    if (pp.startsWith(":")) {
      if (i >= urlParts.length) return null;
      params[pp.slice(1)] = urlParts[i];
      continue;
    }
    if (i >= urlParts.length || urlParts[i] !== pp) return null;
  }
  if (urlParts.length !== patternParts.length) return null;
  return params;
}

// Build a global intercepting route lookup for RSC navigation.
// Maps target URL patterns to { sourceRouteIndex, slotName, interceptPage, params }.
const interceptLookup = [];
for (let ri = 0; ri < routes.length; ri++) {
  const r = routes[ri];
  if (!r.slots) continue;
  for (const [slotName, slotMod] of Object.entries(r.slots)) {
    if (!slotMod.intercepts) continue;
    for (const intercept of slotMod.intercepts) {
      interceptLookup.push({
        sourceRouteIndex: ri,
        slotName,
        targetPattern: intercept.targetPattern,
        page: intercept.page,
        params: intercept.params,
      });
    }
  }
}

/**
 * Check if a pathname matches any intercepting route.
 * Returns the match info or null.
 */
function findIntercept(pathname) {
  for (const entry of interceptLookup) {
    const params = matchPattern(pathname, entry.targetPattern);
    if (params !== null) {
      return { ...entry, matchedParams: params };
    }
  }
  return null;
}

async function buildPageElement(route, params, opts, searchParams) {
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    return h("div", null, "Page has no default export");
  }

  // Resolve metadata and viewport from layouts and page
  const metadataList = [];
  const viewportList = [];
  for (const layoutMod of route.layouts) {
    if (layoutMod) {
      const meta = await resolveModuleMetadata(layoutMod, params);
      if (meta) metadataList.push(meta);
      const vp = await resolveModuleViewport(layoutMod, params);
      if (vp) viewportList.push(vp);
    }
  }
  if (route.page) {
    const pageMeta = await resolveModuleMetadata(route.page, params);
    if (pageMeta) metadataList.push(pageMeta);
    const pageVp = await resolveModuleViewport(route.page, params);
    if (pageVp) viewportList.push(pageVp);
  }
  const resolvedMetadata = metadataList.length > 0 ? mergeMetadata(metadataList) : null;
  const resolvedViewport = viewportList.length > 0 ? mergeViewport(viewportList) : null;

  // Build nested layout tree from outermost to innermost.
  // Next.js 16 passes params/searchParams as Promises (async pattern)
  // but pre-16 code accesses them as plain objects (params.id).
  // We create a "thenable object" that works both ways.
  const asyncParams = Object.assign(Promise.resolve(params), params);
  const pageProps = { params: asyncParams };
  if (searchParams) {
    const spObj = {};
    let hasSearchParams = false;
    if (searchParams.forEach) searchParams.forEach(function(v, k) {
      hasSearchParams = true;
      if (k in spObj) {
        // Multi-value: promote to array (Next.js returns string[] for duplicate keys)
        spObj[k] = Array.isArray(spObj[k]) ? spObj[k].concat(v) : [spObj[k], v];
      } else {
        spObj[k] = v;
      }
    });
    // If the URL has query parameters, mark the page as dynamic.
    // In Next.js, only accessing the searchParams prop signals dynamic usage,
    // but a Proxy-based approach doesn't work here because Preact's debug
    // serializer accesses properties on all props (e.g. $$typeof check in
    // isClientReference), triggering the Proxy even when user code doesn't
    // read searchParams. Checking for non-empty query params is a safe
    // approximation: pages with query params in the URL are almost always
    // dynamic, and this avoids false positives from React internals.
    if (hasSearchParams) markDynamicUsage();
    pageProps.searchParams = Object.assign(Promise.resolve(spObj), spObj);
  }
  let element = h(PageComponent, pageProps);

  // Add metadata + viewport head tags
  // Next.js always injects charset and default viewport even when no metadata/viewport
  // is exported. We replicate that by always emitting these essential head elements.
  {
    const headElements = [];
    // Always emit <meta charset="utf-8"> — Next.js includes this on every page
    headElements.push(h("meta", { charSet: "utf-8" }));
    if (resolvedMetadata) headElements.push(h(MetadataHead, { metadata: resolvedMetadata }));
    // Default viewport to standard responsive settings when none is exported
    const effectiveViewport = resolvedViewport ?? { width: "device-width", initialScale: 1 };
    headElements.push(h(ViewportHead, { viewport: effectiveViewport }));
    element = h(Fragment, null, ...headElements, element);
  }

  // Wrap with loading.tsx Suspense if present
  if (route.loading?.default) {
    element = h(
      Suspense,
      { fallback: h(route.loading.default) },
      element,
    );
  }

  // Wrap with the leaf's error.tsx ErrorBoundary if it's not already covered
  // by a per-layout error boundary (i.e., the leaf has error.tsx but no layout).
  // Per-layout error boundaries are interleaved with layouts below.
  {
    const lastLayoutError = route.errors ? route.errors[route.errors.length - 1] : null;
    if (route.error?.default && route.error !== lastLayoutError) {
      element = h(ErrorBoundary, {
        fallback: route.error.default,
        children: element,
      });
    }
  }

  // Wrap with NotFoundBoundary so client-side notFound() renders not-found.tsx
  // instead of crashing the component tree. Must be above ErrorBoundary since
  // ErrorBoundary re-throws notFound errors.
  // Pre-render the not-found component as a React element since it may be a
  // server component (not a client reference) and can't be passed as a function prop.
  {
    const NotFoundComponent = route.notFound?.default ?? ${rootNotFoundVar ? `${rootNotFoundVar}?.default` : "null"};
    if (NotFoundComponent) {
      element = h(NotFoundBoundary, {
        fallback: h(NotFoundComponent),
        children: element,
      });
    }
  }

  // Wrap with templates (innermost first, then outer)
  // Templates are like layouts but re-mount on navigation (client-side concern).
  // On the server, they just wrap the content like layouts do.
  if (route.templates) {
    for (let i = route.templates.length - 1; i >= 0; i--) {
      const TemplateComponent = route.templates[i]?.default;
      if (TemplateComponent) {
        element = h(TemplateComponent, { children: element, params });
      }
    }
  }

  // Wrap with layouts (innermost first, then outer).
  // At each layout level, first wrap with that level's error boundary (if any)
  // so the boundary is inside the layout and catches errors from children.
  // This matches Next.js behavior: Layout > ErrorBoundary > children.
  // Parallel slots are passed as named props to the innermost layout
  // (the layout at the same directory level as the page/slots)
  for (let i = route.layouts.length - 1; i >= 0; i--) {
    // Wrap with per-layout error boundary before wrapping with layout.
    // This places the ErrorBoundary inside the layout, catching errors
    // from child segments (matching Next.js per-segment error handling).
    if (route.errors && route.errors[i]?.default) {
      element = h(ErrorBoundary, {
        fallback: route.errors[i].default,
        children: element,
      });
    }

    const LayoutComponent = route.layouts[i]?.default;
    if (LayoutComponent) {
      // Per-layout NotFoundBoundary: wraps this layout's children so that
      // notFound() thrown from a child layout is caught here.
      // Matches Next.js behavior where each segment has its own boundary.
      // The boundary at level N catches errors from Layout[N+1] and below,
      // but NOT from Layout[N] itself (which propagates to level N-1).
      {
        const LayoutNotFound = route.notFounds?.[i]?.default;
        if (LayoutNotFound) {
          element = h(NotFoundBoundary, {
            fallback: h(LayoutNotFound),
            children: element,
          });
        }
      }

      const layoutProps = { children: element, params: Object.assign(Promise.resolve(params), params) };

      // Add parallel slot elements to the layout that defines them.
      // Each slot has a layoutIndex indicating which layout it belongs to.
      if (route.slots) {
        for (const [slotName, slotMod] of Object.entries(route.slots)) {
          // Attach slot to the layout at its layoutIndex, or to the innermost layout if -1
          const targetIdx = slotMod.layoutIndex >= 0 ? slotMod.layoutIndex : route.layouts.length - 1;
          if (i !== targetIdx) continue;
          // Check if this slot has an intercepting route that should activate
          let SlotPage = null;
          let slotParams = params;

          if (opts && opts.interceptSlot === slotName && opts.interceptPage) {
            // Use the intercepting route's page component
            SlotPage = opts.interceptPage.default;
            slotParams = opts.interceptParams || params;
          } else {
            SlotPage = slotMod.page?.default || slotMod.default?.default;
          }

          if (SlotPage) {
            let slotElement = h(SlotPage, { params: Object.assign(Promise.resolve(slotParams), slotParams) });
            // Wrap with slot-specific layout if present.
            // In Next.js, @slot/layout.tsx wraps the slot's page content
            // before it is passed as a prop to the parent layout.
            const SlotLayout = slotMod.layout?.default;
            if (SlotLayout) {
              slotElement = h(SlotLayout, {
                children: slotElement,
                params: Object.assign(Promise.resolve(slotParams), slotParams),
              });
            }
            // Wrap with slot-specific loading if present
            if (slotMod.loading?.default) {
              slotElement = h(Suspense,
                { fallback: h(slotMod.loading.default) },
                slotElement,
              );
            }
            // Wrap with slot-specific error boundary if present
            if (slotMod.error?.default) {
              slotElement = h(ErrorBoundary, {
                fallback: slotMod.error.default,
                children: slotElement,
              });
            }
            layoutProps[slotName] = slotElement;
          }
        }
      }

      element = h(LayoutComponent, layoutProps);

      // Wrap the layout with LayoutSegmentProvider so useSelectedLayoutSegments()
      // called INSIDE this layout knows its URL segment depth. The depth tells the
      // hook how many URL segments are above this layout, so it returns only the
      // segments below. We wrap the layout (not just children) because hooks are
      // called from components rendered inside the layout's own JSX.
      const layoutDepth = route.layoutSegmentDepths ? route.layoutSegmentDepths[i] : 0;
      element = h(LayoutSegmentProvider, { depth: layoutDepth }, element);
    }
  }

  // Wrap with global error boundary if app/global-error.tsx exists.
  // This catches errors in the root layout itself.
  ${globalErrorVar ? `
  const GlobalErrorComponent = ${globalErrorVar}.default;
  if (GlobalErrorComponent) {
    element = h(ErrorBoundary, {
      fallback: GlobalErrorComponent,
      children: element,
    });
  }
  ` : ""}

  return element;
}

${middlewarePath ? `
function matchMiddlewarePath(pathname, matcher) {
  if (!matcher) return true;
  const patterns = typeof matcher === "string" ? [matcher]
    : Array.isArray(matcher) ? matcher.map(m => typeof m === "string" ? m : m.source)
    : [];
  return patterns.some(pattern => {
    const reStr = "^" + pattern
      .replace(/\\./g, "\\\\.")
      .replace(/:(\\w+)\\*/g, "(?:.*)")
      .replace(/:(\\w+)\\+/g, "(?:.+)")
      .replace(/:(\\w+)/g, "([^/]+)") + "$";
    const re = __safeRegExp(reStr);
    return re ? re.test(pathname) : false;
  });
}
` : ""}

const __basePath = ${JSON.stringify(bp)};
const __trailingSlash = ${JSON.stringify(ts)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};
const __allowedOrigins = ${JSON.stringify(allowedOrigins)};

// ── CSRF origin validation for server actions ───────────────────────────
// Matches Next.js behavior: compare the Origin header against the Host header.
// If they don't match, the request is rejected with 403 unless the origin is
// in the allowedOrigins list (from experimental.serverActions.allowedOrigins).
function __isOriginAllowed(origin, allowed) {
  for (const pattern of allowed) {
    if (pattern.startsWith("*.")) {
      // Wildcard: *.example.com matches sub.example.com, a.b.example.com
      const suffix = pattern.slice(1); // ".example.com"
      if (origin === pattern.slice(2) || origin.endsWith(suffix)) return true;
    } else if (origin === pattern) {
      return true;
    }
  }
  return false;
}

function __validateCsrfOrigin(request) {
  const originHeader = request.headers.get("origin");
  // If there's no Origin header, allow the request — same-origin requests
  // from non-fetch navigations (e.g. SSR) may lack an Origin header.
  // The x-rsc-action custom header already provides protection against simple
  // form-based CSRF since custom headers can't be set by cross-origin forms.
  if (!originHeader || originHeader === "null") return null;

  let originHost;
  try {
    originHost = new URL(originHeader).host.toLowerCase();
  } catch {
    return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  }

  const hostHeader = (
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    ""
  ).split(",")[0].trim().toLowerCase();

  if (!hostHeader) return null;

  // Same origin — allow
  if (originHost === hostHeader) return null;

  // Check allowedOrigins from next.config.js
  if (__allowedOrigins.length > 0 && __isOriginAllowed(originHost, __allowedOrigins)) return null;

  console.warn(
    \`[vinext] CSRF origin mismatch: origin "\${originHost}" does not match host "\${hostHeader}". Blocking server action request.\`
  );
  return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
}

// ── ReDoS-safe regex compilation ────────────────────────────────────────
function __isSafeRegex(pattern) {
  const quantifierAtDepth = [];
  let depth = 0;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\\\") { i += 2; continue; }
    if (ch === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (quantifierAtDepth.length <= depth) quantifierAtDepth.push(false);
      else quantifierAtDepth[depth] = false;
      i++;
      continue;
    }
    if (ch === ")") {
      const hadQ = depth > 0 && quantifierAtDepth[depth];
      if (depth > 0) depth--;
      const next = pattern[i + 1];
      if (next === "+" || next === "*" || next === "{") {
        if (hadQ) return false;
        if (depth >= 0 && depth < quantifierAtDepth.length) quantifierAtDepth[depth] = true;
      }
      i++;
      continue;
    }
    if (ch === "+" || ch === "*") {
      if (depth > 0) quantifierAtDepth[depth] = true;
      i++;
      continue;
    }
    if (ch === "?") {
      const prev = i > 0 ? pattern[i - 1] : "";
      if (prev !== "+" && prev !== "*" && prev !== "?" && prev !== "}") {
        if (depth > 0) quantifierAtDepth[depth] = true;
      }
      i++;
      continue;
    }
    if (ch === "{") {
      let j = i + 1;
      while (j < pattern.length && /[\\d,]/.test(pattern[j])) j++;
      if (j < pattern.length && pattern[j] === "}" && j > i + 1) {
        if (depth > 0) quantifierAtDepth[depth] = true;
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return true;
}
function __safeRegExp(pattern, flags) {
  if (!__isSafeRegex(pattern)) {
    console.warn("[vinext] Ignoring potentially unsafe regex pattern (ReDoS risk): " + pattern);
    return null;
  }
  try { return new RegExp(pattern, flags); } catch { return null; }
}

// ── Config pattern matching (redirects, rewrites, headers) ──────────────
function __matchConfigPattern(pathname, pattern) {
  if (pattern.includes("(") || pattern.includes("\\\\") || /:\\w+[*+][^/]/.test(pattern)) {
    try {
      const paramNames = [];
      const regexStr = pattern
        .replace(/\\./g, "\\\\.")
        .replace(/:([a-zA-Z_]\\w*)\\*(?:\\(([^)]+)\\))?/g, (_, name, c) => { paramNames.push(name); return c ? "(" + c + ")" : "(.*)"; })
        .replace(/:([a-zA-Z_]\\w*)\\+(?:\\(([^)]+)\\))?/g, (_, name, c) => { paramNames.push(name); return c ? "(" + c + ")" : "(.+)"; })
        .replace(/:([a-zA-Z_]\\w*)\\(([^)]+)\\)/g, (_, name, c) => { paramNames.push(name); return "(" + c + ")"; })
        .replace(/:([a-zA-Z_]\\w*)/g, (_, name) => { paramNames.push(name); return "([^/]+)"; });
      const re = __safeRegExp("^" + regexStr + "$");
      if (!re) return null;
      const match = re.exec(pathname);
      if (!match) return null;
      const params = Object.create(null);
      for (let i = 0; i < paramNames.length; i++) params[paramNames[i]] = match[i + 1] || "";
      return params;
    } catch { /* fall through */ }
  }
  const catchAllMatch = pattern.match(/:([a-zA-Z_]\\w*)(\\*|\\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";
    if (!pathname.startsWith(prefix.replace(/\\/$/, ""))) return null;
    const rest = pathname.slice(prefix.replace(/\\/$/, "").length);
    if (isPlus && (!rest || rest === "/")) return null;
    let restValue = rest.startsWith("/") ? rest.slice(1) : rest;
    try { restValue = decodeURIComponent(restValue); } catch {}
    return { [paramName]: restValue };
  }
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (parts.length !== pathParts.length) return null;
  const params = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = pathParts[i];
    else if (parts[i] !== pathParts[i]) return null;
  }
  return params;
}

function __parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function __checkSingleCondition(condition, ctx) {
  switch (condition.type) {
    case "header": {
      const v = ctx.headers.get(condition.key);
      if (v === null) return false;
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(v) : v === condition.value; }
      return true;
    }
    case "cookie": {
      const v = ctx.cookies[condition.key];
      if (v === undefined) return false;
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(v) : v === condition.value; }
      return true;
    }
    case "query": {
      const v = ctx.query.get(condition.key);
      if (v === null) return false;
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(v) : v === condition.value; }
      return true;
    }
    case "host": {
      if (condition.value !== undefined) { const re = __safeRegExp(condition.value); return re ? re.test(ctx.host) : ctx.host === condition.value; }
      return ctx.host === condition.key;
    }
    default: return false;
  }
}

function __checkHasConditions(has, missing, ctx) {
  if (has) { for (const c of has) { if (!__checkSingleCondition(c, ctx)) return false; } }
  if (missing) { for (const c of missing) { if (__checkSingleCondition(c, ctx)) return false; } }
  return true;
}

function __buildRequestContext(request) {
  const url = new URL(request.url);
  return {
    headers: request.headers,
    cookies: __parseCookies(request.headers.get("cookie")),
    query: url.searchParams,
    host: request.headers.get("host") || url.host,
  };
}

function __applyConfigRedirects(pathname, ctx) {
  for (const rule of __configRedirects) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
      if (ctx && (rule.has || rule.missing)) { if (!__checkHasConditions(rule.has, rule.missing, ctx)) continue; }
      let dest = rule.destination;
      for (const [key, value] of Object.entries(params)) { dest = dest.replace(":" + key + "*", value); dest = dest.replace(":" + key + "+", value); dest = dest.replace(":" + key, value); }
      return { destination: dest, permanent: rule.permanent };
    }
  }
  return null;
}

function __applyConfigRewrites(pathname, rules, ctx) {
  for (const rule of rules) {
    const params = __matchConfigPattern(pathname, rule.source);
    if (params) {
      if (ctx && (rule.has || rule.missing)) { if (!__checkHasConditions(rule.has, rule.missing, ctx)) continue; }
      let dest = rule.destination;
      for (const [key, value] of Object.entries(params)) { dest = dest.replace(":" + key + "*", value); dest = dest.replace(":" + key + "+", value); dest = dest.replace(":" + key, value); }
      return dest;
    }
  }
  return null;
}

function __isExternalUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

const __hopByHopHeaders = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailers","transfer-encoding","upgrade"]);

async function __proxyExternalRequest(request, externalUrl) {
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(externalUrl);
  for (const [key, value] of originalUrl.searchParams) {
    if (!targetUrl.searchParams.has(key)) targetUrl.searchParams.set(key, value);
  }
  const headers = new Headers(request.headers);
  headers.set("host", targetUrl.host);
  headers.delete("connection");
  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  const init = { method, headers, redirect: "manual" };
  if (hasBody && request.body) { init.body = request.body; init.duplex = "half"; }
  let upstream;
  try { upstream = await fetch(targetUrl.href, init); }
  catch (e) { console.error("[vinext] External rewrite proxy error:", e); return new Response("Bad Gateway", { status: 502 }); }
  const respHeaders = new Headers();
  upstream.headers.forEach(function(value, key) { if (!__hopByHopHeaders.has(key.toLowerCase())) respHeaders.append(key, value); });
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
}

function __applyConfigHeaders(pathname) {
  const result = [];
  for (const rule of __configHeaders) {
    const groups = [];
    const withPlaceholders = rule.source.replace(/\\(([^)]+)\\)/g, (_, inner) => {
      groups.push(inner);
      return "___GROUP_" + (groups.length - 1) + "___";
    });
    const escaped = withPlaceholders
      .replace(/\\./g, "\\\\.")
      .replace(/\\+/g, "\\\\+")
      .replace(/\\?/g, "\\\\?")
      .replace(/\\*/g, ".*")
      .replace(/:[a-zA-Z_]\\w*/g, "[^/]+")
      .replace(/___GROUP_(\\d+)___/g, (_, idx) => "(" + groups[Number(idx)] + ")");
    const sourceRegex = __safeRegExp("^" + escaped + "$");
    if (sourceRegex && sourceRegex.test(pathname)) result.push(...rule.headers);
  }
  return result;
}

export default async function handler(request) {
  // Wrap the entire request handling in runWithHeadersContext to ensure
  // headers() and cookies() work throughout the async rendering pipeline.
  // This uses AsyncLocalStorage.run() which properly propagates through awaits.
  const headersCtx = headersContextFromRequest(request);
   return runWithHeadersContext(headersCtx, async () => {
    // Initialize per-request state for cache and private cache isolation.
    _initRequestScopedCacheState();
    _clearPrivateCache();
    // Install patched fetch with Next.js caching semantics for this request.
    // runWithFetchCache uses AsyncLocalStorage.run() for proper per-request
    // isolation of collected fetch tags in concurrent environments.
    return runWithFetchCache(async () => {
      const response = await _handleRequest(request);
      // Apply custom headers from next.config.js to non-redirect responses.
      // Skip redirects (3xx) because Response.redirect() creates immutable headers,
      // and Next.js doesn't apply custom headers to redirects anyway.
      if (__configHeaders.length && response && response.headers && !(response.status >= 300 && response.status < 400)) {
        const url = new URL(request.url);
        let pathname = url.pathname;
        ${bp ? `if (pathname.startsWith(${JSON.stringify(bp)})) pathname = pathname.slice(${JSON.stringify(bp)}.length) || "/";` : ""}
        const extraHeaders = __applyConfigHeaders(pathname);
        for (const h of extraHeaders) {
          response.headers.set(h.key, h.value);
        }
      }
      return response;
    });
  });
}

async function _handleRequest(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;

  // Guard against protocol-relative URL open redirect attacks.
  // Paths like //example.com/ would be redirected to //example.com by the
  // trailing-slash normalizer, which browsers interpret as http://example.com.
  // Next.js returns 404 for these paths. Check the raw pathname before any
  // basePath stripping so the guard cannot be bypassed with a basePath prefix.
  if (pathname.startsWith("//")) {
    return new Response("404 Not Found", { status: 404 });
  }

  ${bp ? `
  // Strip basePath prefix
  if (__basePath && pathname.startsWith(__basePath)) {
    pathname = pathname.slice(__basePath.length) || "/";
  }
  ` : ""}

  // Trailing slash normalization (redirect to canonical form)
  if (pathname !== "/" && !pathname.startsWith("/api")) {
    const hasTrailing = pathname.endsWith("/");
    if (__trailingSlash && !hasTrailing && !pathname.endsWith(".rsc")) {
      return Response.redirect(new URL(__basePath + pathname + "/" + url.search, request.url), 308);
    } else if (!__trailingSlash && hasTrailing) {
      return Response.redirect(new URL(__basePath + pathname.replace(/\\/+$/, "") + url.search, request.url), 308);
    }
  }

  // ── Apply redirects from next.config.js ───────────────────────────────
  const __reqCtx = __buildRequestContext(request);
  if (__configRedirects.length) {
    const __redir = __applyConfigRedirects(pathname, __reqCtx);
    if (__redir) {
      const __redirDest = __basePath && !__redir.destination.startsWith(__basePath)
        ? __basePath + __redir.destination
        : __redir.destination;
      return new Response(null, {
        status: __redir.permanent ? 308 : 307,
        headers: { Location: __redirDest },
      });
    }
  }

  // ── Apply beforeFiles rewrites from next.config.js ────────────────────
  if (__configRewrites.beforeFiles && __configRewrites.beforeFiles.length) {
    const __rewritten = __applyConfigRewrites(pathname, __configRewrites.beforeFiles, __reqCtx);
    if (__rewritten) {
      if (__isExternalUrl(__rewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return __proxyExternalRequest(request, __rewritten);
      }
      pathname = __rewritten;
    }
  }

  const isRscRequest = pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  let cleanPathname = pathname.replace(/\\.rsc$/, "");

  // Middleware response headers to merge into the final response
  let _middlewareResponseHeaders = null;
  // Custom status code from middleware rewrite (e.g. NextResponse.rewrite(url, { status: 403 }))
  let _middlewareRewriteStatus = null;

  ${middlewarePath ? `
   // Run proxy/middleware if present and path matches
  const middlewareFn = middlewareModule.default || middlewareModule.proxy || middlewareModule.middleware;
  const middlewareMatcher = middlewareModule.config?.matcher;
  if (typeof middlewareFn === "function" && matchMiddlewarePath(cleanPathname, middlewareMatcher)) {
    try {
      // Wrap in NextRequest so middleware gets .nextUrl, .cookies, .geo, .ip, etc.
      const nextRequest = request instanceof NextRequest ? request : new NextRequest(request);
      const mwResponse = await middlewareFn(nextRequest);
      if (mwResponse) {
        // Check for x-middleware-next (continue)
        if (mwResponse.headers.get("x-middleware-next") === "1") {
          // Middleware wants to continue - save headers to merge into final response
          _middlewareResponseHeaders = new Headers();
          for (const [key, value] of mwResponse.headers) {
            if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
              _middlewareResponseHeaders.set(key, value);
            }
          }
        } else {
          // Check for redirect
          if (mwResponse.status >= 300 && mwResponse.status < 400) {
            return mwResponse;
          }
          // Check for rewrite
          const rewriteUrl = mwResponse.headers.get("x-middleware-rewrite");
          if (rewriteUrl) {
            const rewriteParsed = new URL(rewriteUrl, request.url);
            cleanPathname = rewriteParsed.pathname;
            // Capture custom status code from rewrite (e.g. NextResponse.rewrite(url, { status: 403 }))
            if (mwResponse.status !== 200) {
              _middlewareRewriteStatus = mwResponse.status;
            }
            // Also save any other headers from the rewrite response
            _middlewareResponseHeaders = new Headers();
            for (const [key, value] of mwResponse.headers) {
              if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") {
                _middlewareResponseHeaders.set(key, value);
              }
            }
          } else {
            // Middleware returned a custom response
            return mwResponse;
          }
        }
      }
    } catch (err) {
      console.error("[vinext] Middleware error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // Unpack x-middleware-request-* headers into the request context so that
  // headers() returns the middleware-modified headers instead of the original
  // request headers. Also strip those internal headers from the set that will
  // be merged into the outgoing HTTP response.
  if (_middlewareResponseHeaders) {
    applyMiddlewareRequestHeaders(_middlewareResponseHeaders);
    for (const key of [..._middlewareResponseHeaders.keys()]) {
      if (key.startsWith("x-middleware-request-")) {
        _middlewareResponseHeaders.delete(key);
      }
    }
  }
  ` : ""}

  // ── Image optimization passthrough (dev mode — no transformation) ───────
  if (cleanPathname === "/_vinext/image") {
    const __imgUrl = url.searchParams.get("url");
    // Allowlist: must start with "/" but not "//" — blocks absolute URLs,
    // protocol-relative, and exotic schemes (data:, javascript:, etc.).
    if (!__imgUrl || !__imgUrl.startsWith("/") || __imgUrl.startsWith("//")) {
      return new Response(!__imgUrl ? "Missing url parameter" : "Only relative URLs allowed", { status: 400 });
    }
    // In dev, redirect to the original asset URL so Vite's static serving handles it.
    return Response.redirect(new URL(__imgUrl, request.url).href, 302);
  }

  // Handle metadata routes (sitemap.xml, robots.txt, manifest.webmanifest, etc.)
  for (const metaRoute of metadataRoutes) {
    if (cleanPathname === metaRoute.servedUrl) {
      if (metaRoute.isDynamic) {
        // Dynamic metadata route — call the default export and serialize
        const metaFn = metaRoute.module.default;
        if (typeof metaFn === "function") {
          const result = await metaFn();
          let body;
          // If it's already a Response (e.g., ImageResponse), return directly
          if (result instanceof Response) return result;
          // Serialize based on type
          if (metaRoute.type === "sitemap") body = sitemapToXml(result);
          else if (metaRoute.type === "robots") body = robotsToText(result);
          else if (metaRoute.type === "manifest") body = manifestToJson(result);
          else body = JSON.stringify(result);
          return new Response(body, {
            headers: { "Content-Type": metaRoute.contentType },
          });
        }
      } else {
        // Static metadata file — decode from embedded base64 data
        try {
          const binary = atob(metaRoute.fileDataBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new Response(bytes, {
            headers: {
              "Content-Type": metaRoute.contentType,
              "Cache-Control": "public, max-age=0, must-revalidate",
            },
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      }
    }
  }

  // Set navigation context for Server Components.
  // Note: Headers context is already set by runWithHeadersContext in the handler wrapper.
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params: {},
  });

  // TODO: Server actions are disabled in Preact mode.
  // The RSC-based server action protocol (decodeReply, loadServerAction, etc.)
  // is not available without @vitejs/plugin-rsc. Server actions need to be
  // re-implemented using standard form POST handling.
  const actionId = request.headers.get("x-rsc-action");
  if (request.method === "POST" && actionId) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Server actions are not yet supported in Preact mode", { status: 501 });
  }

  // ── Apply afterFiles rewrites from next.config.js ──────────────────────
  if (__configRewrites.afterFiles && __configRewrites.afterFiles.length) {
    const __afterRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.afterFiles, __reqCtx);
    if (__afterRewritten) {
      if (__isExternalUrl(__afterRewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return __proxyExternalRequest(request, __afterRewritten);
      }
      cleanPathname = __afterRewritten;
    }
  }

  let match = matchRoute(cleanPathname, routes);

  // ── Fallback rewrites from next.config.js (if no route matched) ───────
  if (!match && __configRewrites.fallback && __configRewrites.fallback.length) {
    const __fallbackRewritten = __applyConfigRewrites(cleanPathname, __configRewrites.fallback, __reqCtx);
    if (__fallbackRewritten) {
      if (__isExternalUrl(__fallbackRewritten)) {
        setHeadersContext(null);
        setNavigationContext(null);
        return __proxyExternalRequest(request, __fallbackRewritten);
      }
      cleanPathname = __fallbackRewritten;
      match = matchRoute(cleanPathname, routes);
    }
  }

  if (!match) {
    // Render custom not-found page if available, otherwise plain 404
    const notFoundResponse = await renderNotFoundPage(null, isRscRequest, request);
    if (notFoundResponse) return notFoundResponse;
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Not Found", { status: 404 });
  }

  const { route, params } = match;

  // Update navigation context with matched params
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params,
  });

  // Handle route.ts API handlers
  if (route.routeHandler) {
    const handler = route.routeHandler;
    const method = request.method.toUpperCase();

    // Collect exported HTTP methods for OPTIONS auto-response and Allow header
    const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
    const exportedMethods = HTTP_METHODS.filter((m) => typeof handler[m] === "function");
    // If GET is exported, HEAD is implicitly supported
    if (exportedMethods.includes("GET") && !exportedMethods.includes("HEAD")) {
      exportedMethods.push("HEAD");
    }
    const hasDefault = typeof handler["default"] === "function";

    // OPTIONS auto-implementation: respond with Allow header and 204
    if (method === "OPTIONS" && typeof handler["OPTIONS"] !== "function") {
      const allowMethods = hasDefault ? HTTP_METHODS : exportedMethods;
      if (!allowMethods.includes("OPTIONS")) allowMethods.push("OPTIONS");
      setHeadersContext(null);
      setNavigationContext(null);
      return new Response(null, {
        status: 204,
        headers: { "Allow": allowMethods.join(", ") },
      });
    }

    // HEAD auto-implementation: run GET handler and strip body
    let handlerFn = handler[method] || handler["default"];
    let isAutoHead = false;
    if (method === "HEAD" && typeof handler["HEAD"] !== "function" && typeof handler["GET"] === "function") {
      handlerFn = handler["GET"];
      isAutoHead = true;
    }

    if (typeof handlerFn === "function") {
      try {
        const response = await handlerFn(request, { params });

        // Collect any Set-Cookie headers from cookies().set()/delete() calls
        const pendingCookies = getAndClearPendingCookies();
        const draftCookie = getDraftModeCookieHeader();
        setHeadersContext(null);
        setNavigationContext(null);

        // If we have pending cookies, create a new response with them attached
        if (pendingCookies.length > 0 || draftCookie) {
          const newHeaders = new Headers(response.headers);
          for (const cookie of pendingCookies) {
            newHeaders.append("Set-Cookie", cookie);
          }
          if (draftCookie) newHeaders.append("Set-Cookie", draftCookie);

          if (isAutoHead) {
            return new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers: newHeaders,
            });
          }
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        }

        if (isAutoHead) {
          // Strip body for auto-HEAD, preserve headers and status
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        return response;
      } catch (err) {
        getAndClearPendingCookies(); // Clear any pending cookies on error
        // Catch redirect() / notFound() thrown from route handlers
        if (err && typeof err === "object" && "digest" in err) {
          const digest = String(err.digest);
          if (digest.startsWith("NEXT_REDIRECT;")) {
            const parts = digest.split(";");
            const redirectUrl = parts[2];
            const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
            setHeadersContext(null);
            setNavigationContext(null);
            return new Response(null, {
              status: statusCode,
              headers: { Location: new URL(redirectUrl, request.url).toString() },
            });
          }
          if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
            const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
            setHeadersContext(null);
            setNavigationContext(null);
            return new Response(null, { status: statusCode });
          }
        }
        setHeadersContext(null);
        setNavigationContext(null);
        console.error("[vinext] Route handler error:", err);
        _reportRequestError(
          err instanceof Error ? err : new Error(String(err)),
          { path: cleanPathname, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
          { routerKind: "App Router", routePath: route.pattern, routeType: "route" },
        ).catch(() => {});
        return new Response(null, { status: 500 });
      }
    }
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response(null, {
      status: 405,
      headers: { Allow: exportedMethods.join(", ") },
    });
  }

  // Build the component tree: layouts wrapping the page
  const PageComponent = route.page?.default;
  if (!PageComponent) {
    setHeadersContext(null);
    setNavigationContext(null);
    return new Response("Page has no default export", { status: 500 });
  }

  // Read route segment config from page module exports
  let revalidateSeconds = typeof route.page?.revalidate === "number" ? route.page.revalidate : null;
  const dynamicConfig = route.page?.dynamic; // 'auto' | 'force-dynamic' | 'force-static' | 'error'
  const dynamicParamsConfig = route.page?.dynamicParams; // true (default) | false
  const isForceStatic = dynamicConfig === "force-static";
  const isDynamicError = dynamicConfig === "error";

  // force-static: replace headers/cookies context with empty values and
  // clear searchParams so dynamic APIs return defaults instead of real data
  if (isForceStatic) {
    setHeadersContext({ headers: new Headers(), cookies: new Map() });
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // dynamic = 'error': set a trap context that throws when headers/cookies are accessed
  if (isDynamicError) {
    const errorMsg = 'Page with \`dynamic = "error"\` used a dynamic API. ' +
      'This page was expected to be fully static, but headers(), cookies(), ' +
      'or searchParams was accessed. Remove the dynamic API usage or change ' +
      'the dynamic config to "auto" or "force-dynamic".';
    const throwingHeaders = new Proxy(new Headers(), {
      get(target, prop) {
        if (typeof prop === "string" && prop !== "then") throw new Error(errorMsg);
        return Reflect.get(target, prop);
      },
    });
    const throwingCookies = new Proxy(new Map(), {
      get(target, prop) {
        if (typeof prop === "string" && prop !== "then") throw new Error(errorMsg);
        return Reflect.get(target, prop);
      },
    });
    setHeadersContext({ headers: throwingHeaders, cookies: throwingCookies });
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // dynamicParams = false: only params from generateStaticParams are allowed
  if (dynamicParamsConfig === false && route.isDynamic && typeof route.page?.generateStaticParams === "function") {
    try {
      // Pass parent params to generateStaticParams (Next.js top-down params passing).
      // Parent params = all matched params that DON'T belong to the leaf page's own dynamic segments.
      // We pass the full matched params; the function uses only what it needs.
      const staticParams = await route.page.generateStaticParams({ params });
      if (Array.isArray(staticParams)) {
        const paramKeys = Object.keys(params);
        const isAllowed = staticParams.some(sp =>
          paramKeys.every(key => {
            const val = params[key];
            const staticVal = sp[key];
            // Allow parent params to not be in the returned set (they're inherited)
            if (staticVal === undefined) return true;
            if (Array.isArray(val)) return JSON.stringify(val) === JSON.stringify(staticVal);
            return String(val) === String(staticVal);
          })
        );
        if (!isAllowed) {
          setHeadersContext(null);
          setNavigationContext(null);
          return new Response("Not Found", { status: 404 });
        }
      }
    } catch (err) {
      console.error("[vinext] generateStaticParams error:", err);
    }
  }

  // force-dynamic: set no-store Cache-Control
  const isForceDynamic = dynamicConfig === "force-dynamic";

  // Check for intercepting routes on RSC requests (client-side navigation).
  // If the target URL matches an intercepting route in a parallel slot,
  // render the source route with the intercepting page in the slot.
  let interceptOpts = undefined;
  if (isRscRequest) {
    const intercept = findIntercept(cleanPathname);
    if (intercept) {
      const sourceRoute = routes[intercept.sourceRouteIndex];
      if (sourceRoute && sourceRoute !== route) {
        // Render the source route (e.g. /feed) with the intercepting page in the slot
        const sourceMatch = matchRoute(sourceRoute.pattern, routes);
        const sourceParams = sourceMatch ? sourceMatch.params : {};
        setNavigationContext({
          pathname: cleanPathname,
          searchParams: url.searchParams,
          params: intercept.matchedParams,
        });
        const interceptElement = await buildPageElement(sourceRoute, sourceParams, {
          interceptSlot: intercept.slotName,
          interceptPage: intercept.page,
          interceptParams: intercept.matchedParams,
        }, url.searchParams);
        // Render intercepted route to HTML using Preact
        const _interceptFontData = {
          links: _getSSRFontLinks(),
          styles: _getSSRFontStyles(),
          preloads: _getSSRFontPreloads(),
        };
        const interceptHtml = await _renderToFullHtml(interceptElement, {
          fontData: _interceptFontData,
          navContext: _getNavigationContext(),
        });
        setHeadersContext(null);
        setNavigationContext(null);
        return new Response(interceptHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      // If sourceRoute === route, apply intercept opts to the normal render
      interceptOpts = {
        interceptSlot: intercept.slotName,
        interceptPage: intercept.page,
        interceptParams: intercept.matchedParams,
      };
    }
  }

  let element;
  try {
    element = await buildPageElement(route, params, interceptOpts, url.searchParams);
  } catch (buildErr) {
    // Check for redirect/notFound/forbidden/unauthorized thrown during metadata resolution or async components
    if (buildErr && typeof buildErr === "object" && "digest" in buildErr) {
      const digest = String(buildErr.digest);
      if (digest.startsWith("NEXT_REDIRECT;")) {
        const parts = digest.split(";");
        const redirectUrl = parts[2];
        const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
        setHeadersContext(null);
        setNavigationContext(null);
        return Response.redirect(new URL(redirectUrl, request.url), statusCode);
      }
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
        const fallbackResp = await renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request);
        if (fallbackResp) return fallbackResp;
        setHeadersContext(null);
        setNavigationContext(null);
        const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
        return new Response(statusText, { status: statusCode });
      }
    }
    // Non-special error (e.g. generateMetadata() threw) — render error.tsx if available
    const errorBoundaryResp = await renderErrorBoundaryPage(route, buildErr, isRscRequest, request);
    if (errorBoundaryResp) return errorBoundaryResp;
    throw buildErr;
  }

  // Note: CSS injection is handled by Vite's built-in CSS processing.

  // Helper: check if an error is a redirect/notFound/forbidden/unauthorized thrown by the navigation shim
  async function handleRenderError(err) {
    if (err && typeof err === "object" && "digest" in err) {
      const digest = String(err.digest);
      if (digest.startsWith("NEXT_REDIRECT;")) {
        const parts = digest.split(";");
        const redirectUrl = parts[2];
        const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
        setHeadersContext(null);
        setNavigationContext(null);
        return Response.redirect(new URL(redirectUrl, request.url), statusCode);
      }
      if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
        const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
        const fallbackResp = await renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request);
        if (fallbackResp) return fallbackResp;
        setHeadersContext(null);
        setNavigationContext(null);
        const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
        return new Response(statusText, { status: statusCode });
      }
    }
    return null;
  }

  // Pre-render layout components to catch notFound()/redirect() thrown from layouts.
  // In Next.js, each layout level has its own NotFoundBoundary. When a layout throws
  // notFound(), the parent layout's boundary catches it and renders the parent's
  // not-found.tsx. Since server-side rendering doesn't activate client error boundaries during
  // server-side rendering, we catch layout-level throws here and render the appropriate
  // fallback page with only the layouts above the throwing one.
  //
  // IMPORTANT: Layout pre-render runs BEFORE page pre-render. In Next.js, layouts
  // render before their children — if a layout throws notFound(), the page never
  // executes. By checking layouts first, we avoid a bug where the page's notFound()
  // triggers renderHTTPAccessFallbackPage with ALL route layouts, but one of those
  // layouts itself throws notFound() during the fallback rendering (causing a 500).
  if (route.layouts && route.layouts.length > 0) {
    const asyncParams = Object.assign(Promise.resolve(params), params);
    for (let li = route.layouts.length - 1; li >= 0; li--) {
      const LayoutComp = route.layouts[li]?.default;
      if (!LayoutComp) continue;
      try {
        const lr = LayoutComp({ params: asyncParams, children: null });
        if (lr && typeof lr === "object" && typeof lr.then === "function") await lr;
      } catch (layoutErr) {
        if (layoutErr && typeof layoutErr === "object" && "digest" in layoutErr) {
          const digest = String(layoutErr.digest);
          if (digest.startsWith("NEXT_REDIRECT;")) {
            const parts = digest.split(";");
            const redirectUrl = parts[2];
            const statusCode = parts[3] ? parseInt(parts[3], 10) : 307;
            setHeadersContext(null);
            setNavigationContext(null);
            return Response.redirect(new URL(redirectUrl, request.url), statusCode);
          }
          if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
            const statusCode = digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10);
            // Find the not-found component from the parent level (the boundary that
            // would catch this in Next.js). Walk up from the throwing layout to find
            // the nearest not-found at a parent layout's directory.
            let parentNotFound = null;
            if (route.notFounds) {
              for (let pi = li - 1; pi >= 0; pi--) {
                if (route.notFounds[pi]?.default) {
                  parentNotFound = route.notFounds[pi].default;
                  break;
                }
              }
            }
            if (!parentNotFound) parentNotFound = ${rootNotFoundVar ? `${rootNotFoundVar}?.default` : "null"};
            // Wrap in only the layouts above the throwing one
            const parentLayouts = route.layouts.slice(0, li);
            const fallbackResp = await renderHTTPAccessFallbackPage(
              route, statusCode, isRscRequest, request,
              { boundaryComponent: parentNotFound, layouts: parentLayouts }
            );
            if (fallbackResp) return fallbackResp;
            setHeadersContext(null);
            setNavigationContext(null);
            const statusText = statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
            return new Response(statusText, { status: statusCode });
          }
        }
        // Not a special error — let it propagate through normal rendering
      }
    }
  }

  // Pre-render the page component to catch redirect()/notFound() thrown synchronously.
  // Server Components are just functions — we can call PageComponent directly to detect
  // these special throws before starting the HTML render.
  //
  // For routes with a loading.tsx Suspense boundary, we skip awaiting async components.
  // The Suspense boundary will handle redirect/notFound thrown during rendering.
  //
  // Because this calls the component outside the render cycle, hooks like use()
  // trigger "Invalid hook call" console.error in dev. Suppress that expected warning.
  const _hasLoadingBoundary = !!(route.loading && route.loading.default);
  const _origConsoleError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].includes("Invalid hook call")) return;
    _origConsoleError.apply(console, args);
  };
  try {
    const testResult = PageComponent({ params });
    // If it's a promise (async component), only await if there's no loading boundary.
    // With a loading boundary, the Suspense pipeline handles async resolution.
    if (testResult && typeof testResult === "object" && typeof testResult.then === "function") {
      if (!_hasLoadingBoundary) {
        await testResult;
      } else {
        // Suppress unhandled promise rejection — with a loading boundary,
        // redirect/notFound errors are handled during rendering.
        testResult.catch(() => {});
      }
    }
  } catch (preRenderErr) {
    const specialResponse = await handleRenderError(preRenderErr);
    if (specialResponse) return specialResponse;
    // Non-special errors from the pre-render test are expected (e.g. use() hook
    // fails outside the render cycle, client references can't execute on server).
    // Only redirect/notFound/forbidden/unauthorized are actionable here — other
    // errors will be properly caught during actual Preact rendering below.
  } finally {
    console.error = _origConsoleError;
  }

  // Render to HTML using Preact
  const fontData = {
    links: _getSSRFontLinks(),
    styles: _getSSRFontStyles(),
    preloads: _getSSRFontPreloads(),
  };

  let fullHtml;
  try {
    fullHtml = await _renderToFullHtml(element, { fontData, navContext: _getNavigationContext() });
  } catch (renderErr) {
    const specialResponse = await handleRenderError(renderErr);
    if (specialResponse) return specialResponse;
    // Non-special error during rendering — render error.tsx if available
    const errorBoundaryResp = await renderErrorBoundaryPage(route, renderErr, isRscRequest, request);
    if (errorBoundaryResp) return errorBoundaryResp;
    throw renderErr;
  }

  // Build HTTP Link header for font preloading.
  const fontPreloads = fontData.preloads || [];
  const fontLinkHeaderParts = [];
  for (const preload of fontPreloads) {
    fontLinkHeaderParts.push("<" + preload.href + ">; rel=preload; as=font; type=" + preload.type + "; crossorigin");
  }
  const fontLinkHeader = fontLinkHeaderParts.length > 0 ? fontLinkHeaderParts.join(", ") : "";

  // Check for draftMode Set-Cookie header (from draftMode().enable()/disable())
  const draftCookie = getDraftModeCookieHeader();

  setHeadersContext(null);
  setNavigationContext(null);

  // Helper to attach draftMode cookie, middleware headers, font Link header, and rewrite status to a response
  function attachMiddlewareContext(response) {
    if (draftCookie) {
      response.headers.append("Set-Cookie", draftCookie);
    }
    // Set HTTP Link header for font preloading
    if (fontLinkHeader) {
      response.headers.set("Link", fontLinkHeader);
    }
    // Merge middleware response headers into the final response
    if (_middlewareResponseHeaders) {
      for (const [key, value] of _middlewareResponseHeaders) {
        response.headers.set(key, value);
      }
    }
    // Apply custom status code from middleware rewrite
    if (_middlewareRewriteStatus) {
      return new Response(response.body, {
        status: _middlewareRewriteStatus,
        headers: response.headers,
      });
    }
    return response;
  }

  // Check if any component called connection(), cookies(), headers(), or noStore()
  // during rendering. If so, treat as dynamic (skip ISR, set no-store).
  const dynamicUsedDuringRender = consumeDynamicUsage();

  // Check if cacheLife() was called during rendering (e.g., page with file-level "use cache").
  // If so, use its revalidation period for the Cache-Control header.
  const requestCacheLife = _consumeRequestScopedCacheLife();
  if (requestCacheLife && requestCacheLife.revalidate !== undefined && revalidateSeconds === null) {
    revalidateSeconds = requestCacheLife.revalidate;
  }

  // force-dynamic: always return no-store (highest priority)
  if (isForceDynamic) {
    return attachMiddlewareContext(new Response(fullHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      },
    }));
  }

  // force-static / error: treat as static regardless of dynamic usage.
  // force-static intentionally provides empty headers/cookies context so
  // dynamic APIs return safe defaults; we ignore the dynamic usage signal.
  // dynamic='error' should have already thrown (via throwing Proxy) if user
  // code accessed dynamic APIs, so reaching here means rendering succeeded.
  if ((isForceStatic || isDynamicError) && (revalidateSeconds === null || revalidateSeconds === 0)) {
    return attachMiddlewareContext(new Response(fullHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=31536000, stale-while-revalidate",
        "X-Vinext-Cache": "STATIC",
      },
    }));
  }

  // auto mode: dynamic API usage (headers(), cookies(), connection(), noStore(),
  // searchParams access) opts the page into dynamic rendering with no-store.
  if (dynamicUsedDuringRender) {
    return attachMiddlewareContext(new Response(fullHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      },
    }));
  }

  // Emit Cache-Control for ISR pages so tests can verify revalidate values,
  // but skip actual caching in dev — every request renders fresh.
  if (revalidateSeconds !== null && revalidateSeconds > 0) {
    return attachMiddlewareContext(new Response(fullHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "s-maxage=" + revalidateSeconds + ", stale-while-revalidate",
      },
    }));
  }

  return attachMiddlewareContext(new Response(fullHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}

/**
 * Generate the virtual SSR entry module.
 *
 * With Preact, the server entry renders directly to HTML, so this module
 * is a minimal stub kept for API compatibility. The handleSsr export is
 * a passthrough — the server entry handles all rendering.
 */
export function generateSsrEntry(): string {
  return `
import { setNavigationContext } from "next/navigation";

/**
 * SSR entry stub for Preact mode.
 *
 * With Preact, the server entry renders directly to HTML using
 * preact-render-to-string. This function is kept for API compatibility
 * but simply passes through the pre-rendered HTML.
 *
 * @param html - Pre-rendered HTML string from the server entry
 * @param navContext - Navigation context (unused in Preact mode)
 * @param fontData - Font data (unused — fonts are injected by the server entry)
 */
export async function handleSsr(html, navContext, fontData) {
  return html;
}
`;
}

/**
 * Generate the virtual browser entry module.
 *
 * This runs in the client (browser). With Preact, the HTML is already
 * in the DOM from server-side rendering. The browser entry hydrates
 * the page using Preact's hydrate() and handles client-side navigation
 * by fetching new HTML pages.
 */
export function generateBrowserEntry(): string {
  return `
import { h, hydrate } from "preact";
import { setClientParams } from "next/navigation";

/**
 * Preact browser entry.
 *
 * The server renders a complete HTML document using preact-render-to-string.
 * This entry handles:
 * 1. Hydrating route params for client-side hooks (useParams)
 * 2. Client-side navigation (falls back to full page loads without RSC)
 * 3. Browser history (popstate) handling
 *
 * TODO: Implement full Preact hydration. This requires reconstructing the
 * same component tree on the client and calling hydrate(element, document).
 * For now, the page works as server-rendered HTML — interactive "use client"
 * components need hydration to be wired up.
 */
async function main() {
  // Read route params from embedded script tag
  if (self.__VINEXT_RSC_PARAMS__) {
    setClientParams(self.__VINEXT_RSC_PARAMS__);
  }

  // Client-side navigation handler.
  // Without RSC streaming, navigation fetches the full HTML page.
  // TODO: Implement smarter client-side navigation (e.g., fetch HTML
  // and swap document body) to avoid full page reloads.
  window.__VINEXT_RSC_NAVIGATE__ = async function navigateRsc(href) {
    window.location.href = href;
  };

  // Handle popstate (browser back/forward)
  window.addEventListener("popstate", () => {
    window.location.reload();
  });

  // HMR: reload on server module updates
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      window.location.reload();
    });
  }
}

main();
`;
}
