/**
 * Based heavily on the excellent blogpost from Philipp Bazun:
 *
 * https://web.archive.org/web/20240203155713/https://www.bazun.me/blog/kiterboard/#reversing-bluetooth
 *
 */

const MAX_BLUETOOTH_MESSAGE_SIZE = 20;
const MESSAGE_BODY_MAX_LENGTH = 255;
const PACKET_MIDDLE = 81;
const PACKET_FIRST = 82;
const PACKET_LAST = 83;
const PACKET_ONLY = 84;
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const BLUETOOTH_UNDEFINED = "navigator.bluetooth is undefined";
const BLUETOOTH_CANCELLED = "User cancelled the requestDevice() chooser.";

let bluetoothDevice = null;

function checksum(data) {
  let i = 0;
  for (const value of data) {
    i = (i + value) & 255;
  }
  return ~i & 255;
}

function wrapBytes(data) {
  if (data.length > MESSAGE_BODY_MAX_LENGTH) {
    return [];
  }

  return [1, data.length, checksum(data), 2, ...data, 3];
}

function encodePosition(position) {
  const position1 = position & 255;
  const position2 = (position & 65280) >> 8;
  return [position1, position2];
}

function encodeColor(color) {
  const substring = color.substring(0, 2);
  const substring2 = color.substring(2, 4);

  const parsedSubstring = parseInt(substring, 16) / 32;
  const parsedSubstring2 = parseInt(substring2, 16) / 32;
  const parsedResult = (parsedSubstring << 5) | (parsedSubstring2 << 2);

  const substring3 = color.substring(4, 6);
  const parsedSubstring3 = parseInt(substring3, 16) / 64;
  const finalParsedResult = parsedResult | parsedSubstring3;

  return finalParsedResult;
}

function encodePositionAndColor(position, ledColor) {
  return [...encodePosition(position), encodeColor(ledColor)];
}

function getBluetoothPacket(frames, placementPositions, colors) {
  const resultArray = [];
  let tempArray = [PACKET_MIDDLE];
  frames.split("p").forEach((frame) => {
    if (frame.length > 0) {
      const [placement, role] = frame.split("r");
      const encodedFrame = encodePositionAndColor(
        Number(placementPositions[placement]),
        colors[role]
      );
      if (tempArray.length + 3 > MESSAGE_BODY_MAX_LENGTH) {
        resultArray.push(tempArray);
        tempArray = [PACKET_MIDDLE];
      }
      tempArray.push(...encodedFrame);
    }
  });

  resultArray.push(tempArray);

  if (resultArray.length === 1) {
    resultArray[0][0] = PACKET_ONLY;
  } else if (resultArray.length > 1) {
    resultArray[0][0] = PACKET_FIRST;
    resultArray[resultArray.length - 1][0] = PACKET_LAST;
  }

  const finalResultArray = [];
  for (const currentArray of resultArray) {
    finalResultArray.push(...wrapBytes(currentArray));
  }

  return Uint8Array.from(finalResultArray);
}

function splitEvery(n, list) {
  if (n <= 0) {
    throw new Error("First argument to splitEvery must be a positive integer");
  }
  var result = [];
  var idx = 0;
  while (idx < list.length) {
    result.push(list.slice(idx, (idx += n)));
  }
  return result;
}

function illuminateClimb(board, bluetoothPacket) {
  const capitalizedBoard = board[0].toUpperCase() + board.slice(1);
  requestDevice(capitalizedBoard)
    .then((device) => {
      return device.gatt.connect();
    })
    .then((server) => {
      return server.getPrimaryService(SERVICE_UUID);
    })
    .then((service) => {
      return service.getCharacteristic(CHARACTERISTIC_UUID);
    })
    .then((characteristic) => {
      const splitMessages = (buffer) =>
        splitEvery(MAX_BLUETOOTH_MESSAGE_SIZE, buffer).map(
          (arr) => new Uint8Array(arr)
        );
      return writeCharacteristicSeries(
        characteristic,
        splitMessages(bluetoothPacket)
      );
    })
    .then(() => console.log("Climb illuminated"))
    .catch((error) => {
      if (error.message !== BLUETOOTH_CANCELLED) {
        const message =
          error.message === BLUETOOTH_UNDEFINED
            ? "Web Bluetooth is not supported on this browser. See https://caniuse.com/web-bluetooth for more information."
            : `Failed to connect to LEDS: ${error}`;
        alert(message);
      }
    });
}

/**
 * Generate Bluetooth packet with automatic protocol detection
 * This is the main entry point for illuminating climbs
 */
async function getBluetoothPacketAuto(board, frames, placementPositions, colors) {
  const capitalizedBoard = board[0].toUpperCase() + board.slice(1);

  try {
    const device = await requestDevice(capitalizedBoard);
    const apiLevel = getAPILevelFromName(device.name);

    if (apiLevel >= 3) {
      return getBluetoothPacket(frames, placementPositions, colors);
    } else {
      return getBluetoothPacketV2(frames, placementPositions, colors);
    }
  } catch (error) {
    return getBluetoothPacketV2(frames, placementPositions, colors);
  }
}

async function writeCharacteristicSeries(characteristic, messages) {
  let returnValue = null;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    returnValue = await characteristic.writeValue(message);

    // Small delay between messages to let board process
    if (i < messages.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return returnValue;
}

async function requestDevice(namePrefix) {
  if (!bluetoothDevice) {
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [
        {
          namePrefix,
        },
      ],
      optionalServices: [SERVICE_UUID],
    });
  }
  return bluetoothDevice;
}

// ============================================================================
// V2 vs V3 PROTOCOL DETECTION
// ============================================================================

/**
 * Parse board API level from Bluetooth device name
 * Format: "BoardName#serial@apiLevel" or "BoardName#serial" (defaults to 2)
 * Example: "Kilter#abc123@3" = API level 3
 */
function getAPILevelFromName(deviceName) {
  const match = deviceName.match(/@(\d+)/);
  return match ? parseInt(match[1]) : 2;
}

/**
 * V2 Protocol: Scale color based on power consumption
 * V2 dims all LEDs to stay under 18W total power budget
 */
function scaledColorV2(colorValue, scale) {
  // scaledColor formula from APK: ((int)(scale * colorValue)) / 64
  return Math.floor((scale * colorValue) / 64);
}

/**
 * V2 Protocol Color Encoding with Power Scaling
 * Used by boards with API level < 3
 * Encodes position (10 bits) + RGB color into 2 bytes
 *
 * IMPORTANT: V2 uses power-scaled colors! For testing, use scale=1.0
 */
function encodeColorV2(color, position, scale = 1.0) {
  // Parse hex color "RRGGBB"
  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);

  // Apply power scaling (V2 specific - dims LEDs to save power)
  const rScaled = scaledColorV2(r, scale);
  const gScaled = scaledColorV2(g, scale);
  const bScaled = scaledColorV2(b, scale);

  // Position split: low 8 bits in byte 1, high 2 bits in byte 2
  const positionLow = position & 255;
  const positionHigh = (position & 0x300) >> 8; // Top 2 bits of 10-bit position

  // Byte 2 encoding (from APK line 141):
  // (bScaled << 2) | (rScaled << 6) | positionHigh | (gScaled << 4)
  // Reordered: [R R R G G G B B] with position bits in bottom 2 bits
  const colorByte = (rScaled << 6) | (gScaled << 4) | (bScaled << 2) | positionHigh;

  return [positionLow, colorByte];
}

/**
 * Generate V2 protocol packet
 * Note: For testing, we use scale=1.0 (full brightness)
 * Real app would calculate scale based on total power consumption
 */
function getBluetoothPacketV2(frames, placementPositions, colors, scale = 1.0) {
  const resultArray = [];
  let tempArray = [77]; // 'M' - middle packet marker

  frames.split("p").forEach((frame) => {
    if (frame.length > 0) {
      const [placement, role] = frame.split("r");
      const ledPosition = Number(placementPositions[placement]);
      const roleColor = colors[role];

      if (ledPosition > 1023) {
        return;
      }

      const encodedFrame = encodeColorV2(roleColor, ledPosition, scale);

      if (tempArray.length + 2 > MESSAGE_BODY_MAX_LENGTH) {
        resultArray.push(tempArray);
        tempArray = [77]; // 'M'
      }
      tempArray.push(...encodedFrame);
    }
  });

  resultArray.push(tempArray);

  // Set packet type markers
  if (resultArray.length === 1) {
    resultArray[0][0] = 80; // 'P' - single packet
  } else if (resultArray.length > 1) {
    resultArray[0][0] = 78; // 'N' - first packet
    resultArray[resultArray.length - 1][0] = 79; // 'O' - last packet
  }

  const finalResultArray = [];
  for (const currentArray of resultArray) {
    finalResultArray.push(...wrapBytes(currentArray));
  }

  return Uint8Array.from(finalResultArray);
}

/**
 * Debug utility to test LED positions by lighting up a chunk of holds
 *
 * Usage:
 *   debugIlluminateAllHolds('kilter', 0)  // Light holds 0-99
 *   debugIlluminateAllHolds('kilter', 1)  // Light holds 100-199
 *   debugIlluminateAllHolds('kilter', 2)  // Light holds 200-299
 *   debugIlluminateAllHolds('kilter', 3)  // Light holds 300-305
 *
 * Note: Board firmware doesn't properly accumulate multi-packet V2 messages,
 * so we chunk into 100-hold sections to stay within single packet limits
 */
async function debugIlluminateAllHolds(board, chunk = 0, chunkSize = 100) {
  const startPos = chunk * chunkSize;
  const endPos = Math.min(startPos + chunkSize, 305);

  console.log(`\n=== DEBUG: Illuminating holds ${startPos}-${endPos - 1} (chunk ${chunk}) ===`);

  try {
    const whiteColor = "FFFFFF";
    let frames = "";
    const placementPositions = {};
    const colors = { "1": whiteColor };

    // Build synthetic frames string for the chunk
    for (let pos = startPos; pos < endPos; pos++) {
      frames += `p${pos}r1`;
      placementPositions[pos] = pos;
    }

    // Use auto-detection to get the correct protocol packet
    const bluetoothPacket = await getBluetoothPacketAuto(
      board,
      frames,
      placementPositions,
      colors
    );

    console.log(`[DEBUG] Sending packet to illuminate ${endPos - startPos} holds...`);
    illuminateClimb(board, bluetoothPacket);

  } catch (error) {
    console.error("[DEBUG] Error:", error);
  }
}

