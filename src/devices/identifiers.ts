/**
 * A device id is not just a map key: on Android it is handed to `adb -s <id>`
 * and on iOS it names a WDA session, so it reaches `execFile` argument vectors
 * from a request body — and, through `devices.json`, from a hand-edited file.
 * execFile never goes through a shell, but a value that starts with `-` is
 * still read by adb as a flag, and whitespace or a slash turns an id into
 * something the callers assume it never is. iOS UDIDs, adb serials and
 * `host:port` wireless serials all fit this shape.
 *
 * Both gates use it: `POST /api/devices` in `api/app.ts` for what arrives over
 * HTTP, and `saveRegisteredDevices` in `devices/registry.ts` for everything
 * that reaches the file, including edits made by hand.
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validDeviceId(value: unknown): value is string {
    return typeof value === 'string' && DEVICE_ID_PATTERN.test(value);
}

/** The message both gates give, so a rejected id reads the same from either. */
export const DEVICE_ID_MESSAGE = 'must be a device id: letters, digits, dot, colon, dash or underscore';
