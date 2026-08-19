import { z } from "zod";
import { execSync } from "child_process";
import { listAllDevices, pickDevice } from "./devices.js";
import { ensureIdbCompanion } from "./idb-companion.js";
import { getAndroidFocusedWindow } from "./focus.js";

export const TapSchema = z.object({
  x: z.number().int().describe("X coordinate in points/pixels"),
  y: z.number().int().describe("Y coordinate in points/pixels"),
  device_id: z.string().optional(),
  platform: z.enum(["ios", "android"]).optional(),
  expected_package: z
    .string()
    .optional()
    .describe(
      "Android only — package name that should currently have focus (e.g. 'net.synnode.nullshift'). If set, a warning is returned when focus is on a different window. Use this to detect ANR dialogs, permission prompts, or stale Activity instances silently swallowing taps."
    ),
});

export const SwipeSchema = z.object({
  x1: z.number().int(),
  y1: z.number().int(),
  x2: z.number().int(),
  y2: z.number().int(),
  duration_ms: z.number().int().min(50).max(5000).optional().default(300),
  device_id: z.string().optional(),
  platform: z.enum(["ios", "android"]).optional(),
});

function isIdbAvailable(): boolean {
  try {
    execSync("which idb", { timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tapIOS(deviceId: string, x: number, y: number): void {
  if (isIdbAvailable()) {
    // idb (Facebook iOS Development Bridge) — preferred, supports tap natively
    ensureIdbCompanion(deviceId);
    execSync(`idb ui tap ${x} ${y} --udid "${deviceId}"`, {
      timeout: 5_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return;
  }

  // Fallback: xcrun simctl io sendtouchJSON (Xcode 14.3+, experimental)
  // Format: {"x": 100, "y": 200, "type": "touch"}
  const touchJson = JSON.stringify({ touches: [{ x, y, action: "began" }] });
  try {
    execSync(`echo '${touchJson}' | xcrun simctl io "${deviceId}" sendtouchJSON -`, {
      timeout: 5_000,
      stdio: ["pipe", "ignore", "pipe"],
    });
    return;
  } catch {
    // sendtouchJSON not available on this Xcode version
  }

  throw new Error(
    `iOS tap requires idb (Facebook iOS Development Bridge).\n` +
    `Install via: brew install idb-companion && pip3 install fb-idb\n` +
    `Or: brew install facebook/fb/idb-companion`
  );
}

interface AndroidTapResult {
  warnings: string[];
}

function tapAndroid(
  deviceId: string,
  x: number,
  y: number,
  expectedPackage?: string,
): AndroidTapResult {
  const warnings: string[] = [];
  const focus = getAndroidFocusedWindow(deviceId);

  if (focus?.isAnrDialog) {
    throw new Error(
      `Tap blocked: an ANR ('Application Not Responding') system dialog has focus on this device ('${focus.displayName}'). ` +
        `Synthetic taps via 'adb input tap' route to the focused window, so this tap would never reach your app. ` +
        `Resolve via: 'adb shell am force-stop ${expectedPackage ?? "<your-package>"}' followed by 'adb reboot', or 'adb shell pm clear ${expectedPackage ?? "<your-package>"}' (destroys app data).`,
    );
  }

  if (focus && expectedPackage && focus.package !== expectedPackage) {
    warnings.push(
      `Focused window is '${focus.displayName}', not '${expectedPackage}'. The tap may not reach your app — common causes: system dialog on top, stale Activity instance focused, or a different app in the foreground.`,
    );
  }

  // Frame check — skip when the focused window has a degenerate frame
  // (system overlays like NotificationShade often report 0x0 mFrame while
  // their real touchable region is defined separately) to avoid false positives.
  if (focus?.frame) {
    const { x1, y1, x2, y2 } = focus.frame;
    const hasArea = x2 > x1 && y2 > y1;
    if (hasArea && (x < x1 || x > x2 || y < y1 || y > y2)) {
      warnings.push(
        `Tap coordinates (${x}, ${y}) fall outside the focused window's frame [${x1},${y1}]-[${x2},${y2}]. The event may not be dispatched to '${focus.displayName}'.`,
      );
    }
  }

  execSync(`adb -s "${deviceId}" shell input tap ${x} ${y}`, {
    timeout: 5_000,
    stdio: ["ignore", "ignore", "pipe"],
  });

  return { warnings };
}

function swipeIOS(deviceId: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): void {
  if (isIdbAvailable()) {
    // idb supports swipe natively
    ensureIdbCompanion(deviceId);
    const durationSec = (durationMs / 1000).toFixed(2);
    // `idb ui swipe` takes exactly four positionals (x_start y_start x_end
    // y_end) and duration as an option — passing it positionally makes idb
    // reject the call with "unrecognized arguments".
    execSync(`idb ui swipe ${x1} ${y1} ${x2} ${y2} --duration ${durationSec} --udid "${deviceId}"`, {
      timeout: durationMs + 5_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return;
  }

  throw new Error(
    `iOS swipe requires idb (Facebook iOS Development Bridge).\n` +
    `Install via: brew install idb-companion && pip3 install fb-idb`
  );
}

function swipeAndroid(deviceId: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): void {
  execSync(`adb -s "${deviceId}" shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, {
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export function tap(params: z.infer<typeof TapSchema>): string {
  const devices = listAllDevices();
  if (!devices.length) {
    return "No active simulators or emulators found.";
  }

  const device = pickDevice(params.platform, params.device_id);
  if (!device) {
    return `No matching device found. Available: ${devices.map((d) => `${d.name} (${d.platform})`).join(", ")}`;
  }

  try {
    if (device.platform === "ios") {
      tapIOS(device.id, params.x, params.y);
      return `Tapped (${params.x}, ${params.y}) on ${device.name} [ios].`;
    }

    const { warnings } = tapAndroid(device.id, params.x, params.y, params.expected_package);
    let message = `Tapped (${params.x}, ${params.y}) on ${device.name} [android].`;
    if (warnings.length) {
      message += `\n\nWarnings:\n- ${warnings.join("\n- ")}`;
    }
    return message;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tap failed: ${msg}`;
  }
}

export function swipe(params: z.infer<typeof SwipeSchema>): string {
  const devices = listAllDevices();
  if (!devices.length) {
    return "No active simulators or emulators found.";
  }

  const device = pickDevice(params.platform, params.device_id);
  if (!device) {
    return `No matching device found. Available: ${devices.map((d) => `${d.name} (${d.platform})`).join(", ")}`;
  }

  try {
    if (device.platform === "ios") {
      swipeIOS(device.id, params.x1, params.y1, params.x2, params.y2, params.duration_ms);
      return `Swiped from (${params.x1}, ${params.y1}) to (${params.x2}, ${params.y2}) on ${device.name} [ios]. Note: iOS swipe simulation is limited — use Android for reliable swipe gestures.`;
    } else {
      swipeAndroid(device.id, params.x1, params.y1, params.x2, params.y2, params.duration_ms);
      return `Swiped from (${params.x1}, ${params.y1}) to (${params.x2}, ${params.y2}) on ${device.name} [android] over ${params.duration_ms}ms.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Swipe failed: ${msg}`;
  }
}
