import { z } from "zod";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listAllDevices, pickDevice } from "./devices.js";

export const ScreenshotSchema = z.object({
  device_id: z.string().optional(),
  platform: z.enum(["ios", "android"]).optional(),
});

function getIosScaleFactor(imagePath: string, deviceId: string): number {
  // Authoritative: idb reports the device's backing-scale (density) and the
  // point-space that `idb ui tap/swipe` actually uses. Dividing the screenshot
  // pixels by this density yields the exact coordinate space of those tools,
  // for any device, orientation, or Display-Zoom setting. The pixel heuristic
  // below cannot tell a 3x iPhone from a 2x iPad Pro (e.g. the iPad Pro 13"'s
  // 2064px width is divisible by 3), so only use it when idb is unavailable.
  try {
    const out = execSync(`idb describe --udid "${deviceId}" --json`, {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const density = JSON.parse(out)?.screen_dimensions?.density;
    if (typeof density === "number" && density >= 1) return density;
  } catch {
    // fall through to the pixel-size heuristic below
  }

  // Use sips to read pixel dimensions of the screenshot
  try {
    const output = execSync(`sips -g pixelWidth -g pixelHeight "${imagePath}"`, {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();

    const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
    const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
    if (!widthMatch || !heightMatch) return 1;

    const pixelWidth = parseInt(widthMatch[1]);
    const pixelHeight = parseInt(heightMatch[1]);

    // Common iOS simulator logical resolutions (points):
    // iPhone 16 Pro Max: 440x956, scale 3x → 1320x2868px
    // iPhone 16 Pro:     393x852, scale 3x → 1179x2556px
    // iPhone 16:         390x844, scale 3x → 1170x2532px
    // iPhone SE (3rd):   375x667, scale 2x → 750x1334px
    // iPad Pro 13":      1024x1366, scale 2x → 2048x2732px
    // Use width to determine scale: if width is divisible by 3 and > 1000 → 3x, else 2x
    const longSide = Math.max(pixelWidth, pixelHeight);
    if (longSide >= 2500 && pixelWidth % 3 === 0) return 3;
    if (longSide >= 2500) return 3; // assume 3x for modern iPhones
    if (longSide >= 1334) return 2;
    return 1;
  } catch {
    return 1;
  }
}

function captureIOS(deviceId: string, outputPath: string): void {
  execSync(`xcrun simctl io "${deviceId}" screenshot "${outputPath}"`, {
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Downscale from pixels to logical points so coordinates match idb ui tap
  const scale = getIosScaleFactor(outputPath, deviceId);
  if (scale > 1) {
    try {
      // Read pixel dimensions
      const sipsOut = execSync(`sips -g pixelWidth -g pixelHeight "${outputPath}"`, {
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const wMatch = sipsOut.match(/pixelWidth:\s*(\d+)/);
      const hMatch = sipsOut.match(/pixelHeight:\s*(\d+)/);
      if (wMatch && hMatch) {
        const logicalWidth = Math.round(parseInt(wMatch[1]) / scale);
        const logicalHeight = Math.round(parseInt(hMatch[1]) / scale);
        const resizedPath = outputPath.replace(".png", "-points.png");
        execSync(`sips -z ${logicalHeight} ${logicalWidth} "${outputPath}" --out "${resizedPath}"`, {
          timeout: 10_000,
          stdio: "ignore",
        });
        fs.renameSync(resizedPath, outputPath);
      }
    } catch {
      // sips resize failed — return original at pixel resolution
    }
  }
}

function captureAndroid(deviceId: string, outputPath: string): void {
  const tmpDevice = `/sdcard/mcp_screenshot_${Date.now()}.png`;
  execSync(`adb -s "${deviceId}" shell screencap -p "${tmpDevice}"`, {
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  execSync(`adb -s "${deviceId}" pull "${tmpDevice}" "${outputPath}"`, {
    timeout: 10_000,
    stdio: ["ignore", "ignore", "pipe"],
  });
  execSync(`adb -s "${deviceId}" shell rm "${tmpDevice}"`, {
    timeout: 5_000,
    stdio: "ignore",
  });
}

function getPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  // PNG signature is 8 bytes, then IHDR chunk: 4 length + 4 type + 4 width + 4 height
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null; // PNG magic
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

export function screenshot(params: z.infer<typeof ScreenshotSchema>): {
  type: "image";
  data: string;
  mimeType: string;
  width: number;
  height: number;
} | { type: "text"; text: string } {
  const devices = listAllDevices();
  if (!devices.length) {
    return {
      type: "text",
      text: "No active simulators or emulators found. Start a simulator (iOS) or emulator (Android) first.",
    };
  }

  const device = pickDevice(params.platform, params.device_id);
  if (!device) {
    return {
      type: "text",
      text: `No matching device found. Available: ${devices.map((d) => `${d.name} (${d.platform})`).join(", ")}`,
    };
  }

  const outputPath = path.join(os.tmpdir(), `expo-mcp-screenshot-${Date.now()}.png`);

  try {
    if (device.platform === "ios") {
      captureIOS(device.id, outputPath);
    } else {
      captureAndroid(device.id, outputPath);
    }

    const imageBuffer = fs.readFileSync(outputPath);
    const imageData = imageBuffer.toString("base64");
    const dims = getPngDimensions(imageBuffer);
    fs.unlinkSync(outputPath);

    return {
      type: "image",
      data: imageData,
      mimeType: "image/png",
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
    };
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    return { type: "text", text: `Screenshot failed: ${msg}` };
  }
}
