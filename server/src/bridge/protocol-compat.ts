export const MINIMUM_HERDR_PROTOCOL = 14;
const MAXIMUM_HERDR_PROTOCOL = 0xffffffff;

// Herdr requires clients to echo the server's exact protocol in Hello. Versions
// 14-17 kept the terminal wire variants used by the GUI stable, so optimistically
// allow newer versions as well instead of rejecting them solely for a newer
// number. A future release that changes a used wire layout will require a GUI
// codec update.
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
// value; App stays 0 on every protocol.
export const APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL = 20;

export function terminalAttachLaunchModeWireValue(protocol: number): number {
  return protocol >= APP_DIRECT_GRAPHICS_LAUNCH_MODE_PROTOCOL ? 2 : 1;
}

export function assertSupportedHerdrProtocol(protocol: number): void {
  if (
    !Number.isSafeInteger(protocol) ||
    protocol < 0 ||
    protocol > MAXIMUM_HERDR_PROTOCOL
  ) {
    throw new Error(`Herdr returned an invalid protocol version: ${protocol}`);
  }
  if (!isSupportedHerdrProtocol(protocol)) {
    throw new Error(
      `Herdr protocol ${protocol} is not supported by this Herdr Studio build ` +
        `(requires protocol ${MINIMUM_HERDR_PROTOCOL} or newer)`,
    );
  }
}
