export function loopbackHttpOrigin(value: string) {
  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Local service must be a credential-free loopback HTTP origin.");
  }
  return url.origin;
}
