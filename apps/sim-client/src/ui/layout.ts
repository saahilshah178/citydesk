/** Fixed geometry of the Echo Show style frame, in CSS pixels before the frame is scaled to fit. */

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;
export const BEZEL = 26;
export const DEVICE_WIDTH = SCREEN_WIDTH + BEZEL * 2;
export const DEVICE_HEIGHT = SCREEN_HEIGHT + BEZEL * 2;

/** The area a card (MCP App view) is given. Passed to the view as its container dimensions. */
export const CARD_WIDTH = 1216;
// Screen height 800 minus the top bar (64), the captions beside a card (112) and the status row (46),
// less a little breathing room. Cards authored at 768x480 are shown at 572 / 480 = 1.19x.
export const CARD_MAX_HEIGHT = 572;
export const CARD_MIN_HEIGHT = 120;
