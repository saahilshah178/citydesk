/** Fixed geometry of the Echo Show style frame, in CSS pixels before the frame is scaled to fit. */

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;
export const BEZEL = 26;
export const DEVICE_WIDTH = SCREEN_WIDTH + BEZEL * 2;
export const DEVICE_HEIGHT = SCREEN_HEIGHT + BEZEL * 2;

/** The area a card (MCP App view) is given. Passed to the view as its container dimensions. */
export const CARD_WIDTH = 1216;
export const CARD_MAX_HEIGHT = 520;
export const CARD_MIN_HEIGHT = 120;
