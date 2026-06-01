// SPA mode: render entirely on the client. The static adapter emits a
// fallback index.html so CloudFront can serve any route to the SPA.
export const ssr = false;
export const prerender = false;
export const trailingSlash = "always";
