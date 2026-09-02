export const MINIMUM_HERDR_PROTOCOL = 14;

// Highest Herdr protocol this build knows how to encode. Protocol 22 (Herdr
// 0.9.x) replaced ClientMessage::Hello with TerminalHello and renumbered
// ServerMessage variants; anything newer has an unknown wire layout and must
// fail with a clear error instead of silently mis-decoding frames.
export const MAXIMUM_HERDR_PROTOCOL = 22;

// Sanity bound for obviously corrupt version numbers, not a support claim.
const PROTOCOL_INTEGER_CEILING = 0xffffffff;

// Herdr requires clients to echo the server's exact protocol in the handshake.
// Versions 14-21 share the legacy Hello wire layout; version 22 (Herdr 0.9.x)
// removed launch_mode/requested_encoding/keybindings from the handshake.
export const TERMINAL_HELLO_PROTOCOL = 22;

export function isTerminalHelloProtocol(protocol: number): boolean {
  return protocol >= TERMINAL_HELLO_PROTOCOL;
}

export function isSupportedHerdrProtocol(protocol: number): boolean {
  return (
    Number.isSafeInteger(protocol) &&
    protocol >= MINIMUM_HERDR_PROTOCOL &&
    protocol <= MAXIMUM_HERDR_PROTOCOL
  );
}

// Herdr 0.8.2 (protocol 20) inserted ClientLaunchMode::AppDirectGraphics at
// wire index 1, moving ClientLaunchMode::TerminalAttach from 1 to 2. Map the
// semantic terminal-attach launch mode onto the negotiated protocol's wire
// value; App stays 0 on every protocol. Only meaningful below protocol 22,
// which dropped the launch_mode field from the handshake entirely.
export const APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL = 20;

export function terminalAttachLaunchModeWireValue(protocol: number): number {
  return protocol >= APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL ? 2 : 1;
}

export function assertSupportedHerdrProtocol(protocol: number): void {
  if (
    !Number.isSafeInteger(protocol) ||
    protocol < 0 ||
    protocol > PROTOCOL_INTEGER_CEILING
  ) {
    throw new Error(`Herdr returned an invalid protocol version: ${protocol}`);
  }
  if (!isSupportedHerdrProtocol(protocol)) {
    throw new Error(
      `Herdr protocol ${protocol} is not supported by this Herdr Studio build ` +
        `(supports protocols ${MINIMUM_HERDR_PROTOCOL}-${MAXIMUM_HERDR_PROTOCOL})`,
    );
  }
}
