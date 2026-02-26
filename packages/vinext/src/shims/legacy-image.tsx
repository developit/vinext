/**
 * next/legacy/image shim
 *
 * Provides the pre-Next.js 13 Image component API with layout prop.
 * Translates legacy props (layout, objectFit, objectPosition) to the
 * modern Image component's fill/style props.
 *
 * This module is used by apps that ran the `next-image-to-legacy-image`
 * codemod when upgrading from Next.js 12.
 */
import type { JSX } from "preact";
import { forwardRef } from "preact/compat";
import Image from "./image.js";

interface LegacyImageProps {
  src: string | { src: string; width: number; height: number; blurDataURL?: string };
  alt: string;
  width?: number | string;
  height?: number | string;
  /** Legacy layout mode */
  layout?: "fixed" | "intrinsic" | "responsive" | "fill";
  /** CSS object-fit (used with layout="fill") */
  objectFit?: JSX.CSSProperties["objectFit"];
  /** CSS object-position (used with layout="fill") */
  objectPosition?: string;
  priority?: boolean;
  quality?: number;
  placeholder?: "blur" | "empty";
  blurDataURL?: string;
  loader?: (params: { src: string; width: number; quality?: number }) => string;
  sizes?: string;
  className?: string;
  style?: JSX.CSSProperties;
  onLoad?: JSX.GenericEventHandler<HTMLImageElement>;
  onLoadingComplete?: (result: { naturalWidth: number; naturalHeight: number }) => void;
  onError?: JSX.GenericEventHandler<HTMLImageElement>;
  loading?: "lazy" | "eager";
  unoptimized?: boolean;
  id?: string;
}

const LegacyImage = forwardRef<HTMLImageElement, LegacyImageProps>(
  function LegacyImage(props, ref) {
    const {
      layout = "intrinsic",
      objectFit,
      objectPosition,
      onLoadingComplete,
      onLoad,
      width,
      height,
      style,
      ...rest
    } = props;

    // Translate legacy props to modern Image props
    const modernStyle: JSX.CSSProperties = { ...style };

    if (objectFit) modernStyle.objectFit = objectFit;
    if (objectPosition) modernStyle.objectPosition = objectPosition;

    const handleLoad = onLoadingComplete
      ? (e: JSX.TargetedEvent<HTMLImageElement>) => {
          const img = e.currentTarget;
          onLoadingComplete({
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
          });
          onLoad?.(e);
        }
      : onLoad;

    if (layout === "fill") {
      return (
        <Image
          ref={ref}
          fill
          style={modernStyle}
          onLoad={handleLoad}
          {...rest}
        />
      );
    }

    if (layout === "responsive") {
      // Responsive: takes full width, maintains aspect ratio
      modernStyle.width = "100%";
      modernStyle.height = "auto";
    }

    // For "fixed" and "intrinsic", pass width/height directly
    const w = typeof width === "string" ? parseInt(width, 10) : width;
    const h = typeof height === "string" ? parseInt(height, 10) : height;

    return (
      <Image
        ref={ref}
        width={w}
        height={h}
        style={modernStyle}
        onLoad={handleLoad}
        {...rest}
      />
    );
  },
);

export default LegacyImage;
