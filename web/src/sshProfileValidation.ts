const SSH_DESTINATION_MAX_LENGTH = 320;
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const REMOTE_SOCKET_SEGMENT_PATTERN = /^[A-Za-z0-9._~+@%=-]+$/;

export function validateSshDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SSH_DESTINATION_MAX_LENGTH ||
    !/^[\x21-\x7e]+$/.test(value) ||
    value.startsWith("-") ||
    /[\s/=:,]/.test(value) ||
    value.includes("://")
  ) {
    throw new Error(
      "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
    );
  }
  const parts = value.split("@");
  if (parts.length > 2) {
    throw new Error(
      "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
    );
  }
  const host = parts.length === 2 ? parts[1] : parts[0];
  const user = parts.length === 2 ? parts[0] : undefined;
  if (
    !SSH_HOST_PATTERN.test(host) ||
    (user !== undefined && !SSH_USER_PATTERN.test(user))
  ) {
    throw new Error(
      "SSH destination must be an OpenSSH alias or user@host. Use an OpenSSH config alias for custom ports.",
    );
  }
  return value;
}

export function validateRemoteSocketPath(
  value: unknown,
  field: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    new TextEncoder().encode(value).length > 100 ||
    !value.startsWith("/") ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /[:\\\s]/.test(value)
  ) {
    throw new Error(`${field} path must be a short absolute POSIX path.`);
  }
  const segments = value.split("/").slice(1);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !REMOTE_SOCKET_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`${field} path must be a short absolute POSIX path.`);
  }
  return value;
}
