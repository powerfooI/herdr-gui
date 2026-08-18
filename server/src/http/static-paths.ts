import { isAbsolute, relative, resolve, sep } from "node:path";

export function decodeStaticPathname(rawPathname: string): string | null {
  try {
    const pathname = decodeURIComponent(rawPathname);
    if (pathname.includes("\0")) return null;
    return pathname === "/" ? "/index.html" : pathname;
  } catch {
    return null;
  }
}

export function resolvePublicFilePath(
  publicDir: string,
  pathname: string,
): string | null {
  const root = resolve(publicDir);
  const candidate = resolve(root, `.${pathname}`);
  const child = relative(root, candidate);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return null;
  }
  return candidate;
}

export function shouldServeSpaEntry(
  method: string,
  accept: string | null,
): boolean {
  return (
    isStaticRequestMethod(method) && Boolean(accept?.includes("text/html"))
  );
}

export function isStaticRequestMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
