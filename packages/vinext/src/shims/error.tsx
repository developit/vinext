/**
 * next/error shim
 *
 * Provides the default Next.js error page component.
 * Used by apps that import `import Error from 'next/error'` for
 * custom error handling in getServerSideProps or API routes.
 */
import { h, type VNode } from "preact";

interface ErrorProps {
  statusCode: number;
  title?: string;
  withDarkMode?: boolean;
}

function ErrorComponent({ statusCode, title }: ErrorProps): VNode<any> {
  const defaultTitle =
    statusCode === 404
      ? "This page could not be found"
      : "Internal Server Error";

  const displayTitle = title ?? defaultTitle;

  return h(
    "div",
    {
      style: {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        height: "100vh",
        textAlign: "center" as const,
        display: "flex",
        flexDirection: "column" as const,
        alignItems: "center",
        justifyContent: "center",
      },
    },
    h(
      "div",
      null,
      h(
        "h1",
        {
          style: {
            display: "inline-block",
            margin: "0 20px 0 0",
            padding: "0 23px 0 0",
            fontSize: 24,
            fontWeight: 500,
            verticalAlign: "top",
            lineHeight: "49px",
            borderRight: "1px solid rgba(0, 0, 0, .3)",
          },
        },
        statusCode,
      ),
      h(
        "div",
        { style: { display: "inline-block" } },
        h(
          "h2",
          {
            style: {
              fontSize: 14,
              fontWeight: 400,
              lineHeight: "49px",
              margin: 0,
            },
          },
          displayTitle + ".",
        ),
      ),
    ),
  );
}

export default ErrorComponent;
