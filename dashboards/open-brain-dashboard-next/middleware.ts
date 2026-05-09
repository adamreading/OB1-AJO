import { NextRequest, NextResponse } from "next/server";

// Routes absorbed into /thoughts. Old URLs redirect with prefilters so any
// external link or bookmark still lands on the right view.
const REDIRECTS: Record<string, (url: URL) => URL> = {
  "/search": (url) => {
    const target = new URL("/thoughts", url);
    const q = url.searchParams.get("q");
    if (q) target.searchParams.set("q", q);
    return target;
  },
  "/audit": (url) => {
    const target = new URL("/thoughts", url);
    target.searchParams.set("score_max", "15");
    return target;
  },
  "/duplicates": (url) => {
    const target = new URL("/thoughts", url);
    target.searchParams.set("duplicates", "1");
    return target;
  },
  "/ingest": (url) => {
    const target = new URL("/thoughts", url);
    target.searchParams.set("compose", "1");
    return target;
  },
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow login page, API routes, and static assets
  if (
    pathname === "/login" ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  // Check for session cookie existence (iron-session encrypts it)
  const sessionCookie = request.cookies.get("open_brain_session");
  if (!sessionCookie?.value) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect absorbed routes to /thoughts with the right prefilter
  const redirectFn = REDIRECTS[pathname];
  if (redirectFn) {
    return NextResponse.redirect(redirectFn(request.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
