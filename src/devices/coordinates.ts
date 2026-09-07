export interface Point {
    x: number;
    y: number;
}

export interface DeviceCoordinates {
    displayName: string;
    productTypes: readonly string[];
    screenSize: {
        width: number;
        height: number;
    };
    passcodeKeypad: {
        columnX: [number, number, number];
        rowY: [number, number, number, number];
    };
    tiktok: {
        profileTab: Point;
        homeTab: Point;
        accountSwitcher: Point;
        create: Point;
        upload: Point;
        selectMultiple: Point;
        useLayout: Point;
        /** Photo mode: the picker's images tab, the editor's photo-mode toggle, and the
         *  way past the template chooser. Unverified — see docs/coordinates.md. */
        photoTab: Point;
        photoModeToggle: Point;
        photoTemplateSkip: Point;
        picker: {
            circleX: number;
            columnStep: number;
            firstY: number;
            trayY: number;
            rowStep: number;
            cellX: number;
            cellStep: number;
            cellY: number;
        };
        pickerNext: Point;
        editorNext: Point;
        caption: Point;
        keyboardBack: Point;
        draft: Point;
        finish: Point;
        like: Point;
        save: Point;
        swipe: {
            x: number;
            startY: number;
            endY: number;
            durationMs: number;
        };
    };
    /**
     * Every tap and swipe the built-in Instagram plugin's iOS routines use. Instagram gets its own
     * section rather than sharing TikTok's: the two apps put the composer, the picker grid and the
     * engagement rail in different places, and a shared point would silently be wrong for one of
     * them.
     *
     * **Every value below is unverified** — see docs/coordinates.md and docs/instagram.md. Nobody
     * has calibrated Instagram against a real iPhone 8 yet; the numbers are the TikTok layout's
     * nearest equivalents, which is a starting point for a calibration session and nothing more.
     */
    instagram: {
        homeTab: Point;
        reelsTab: Point;
        profileTab: Point;
        accountSwitcher: Point;
        create: Point;
        /** The surface strip under the picker: POST / STORY / REEL. */
        postTab: Point;
        reelTab: Point;
        selectMultiple: Point;
        picker: {
            cellX: number;
            cellStep: number;
            cellY: number;
            rowStep: number;
        };
        pickerNext: Point;
        editorNext: Point;
        caption: Point;
        keyboardBack: Point;
        /** "Save draft" on the sheet that backing out of the share screen opens. */
        draft: Point;
        share: Point;
        like: Point;
        save: Point;
        swipe: {
            x: number;
            startY: number;
            endY: number;
            durationMs: number;
        };
    };
    /**
     * Every tap the built-in YouTube Shorts plugin's iOS routines use. **None of these have been
     * measured on a real device** — they are the TikTok layout's geometry reasoned onto YouTube's
     * screens, and they are the first thing to check when an iPhone Shorts run misses. See
     * docs/coordinates.md and docs/youtube.md.
     */
    youtube: {
        homeTab: Point;
        shortsTab: Point;
        accountAvatar: Point;
        create: Point;
        upload: Point;
        /** The newest cell in the picker's Recents grid. */
        firstCell: Point;
        next: Point;
        titleField: Point;
        descriptionField: Point;
        keyboardBack: Point;
        visibility: Point;
        publicOption: Point;
        audience: Point;
        notMadeForKids: Point;
        uploadShort: Point;
        saveDraft: Point;
        like: Point;
        subscribe: Point;
        comment: Point;
        commentField: Point;
        commentSend: Point;
        swipe: {
            x: number;
            startY: number;
            endY: number;
            durationMs: number;
        };
    };
    /**
     * The Threads (Meta) plugin's iOS tap targets. Every value below is a GUESS measured from
     * nothing — see docs/coordinates.md. The Android Threads routines never read these; they use
     * the accessibility tree.
     */
    threads: ThreadsCoordinates;
}

/** iOS tap targets for com.burbn.barcelona, in points. */
export interface ThreadsCoordinates {
    homeTab: Point;
    profileTab: Point;
    /** The handle / chevron in the profile header that opens the account list. */
    accountSwitcher: Point;
    /** The compose pencil in the bottom bar. */
    compose: Point;
    /** The paperclip / image button inside the composer. */
    attach: Point;
    /** The text box inside the composer. */
    composerField: Point;
    /** The first (newest) cell of the photo picker, and the picker's confirm control. */
    pickerFirstCell: Point;
    pickerColumnStep: number;
    pickerRowStep: number;
    pickerAdd: Point;
    /** Dismisses the keyboard without leaving the composer. */
    keyboardDone: Point;
    post: Point;
    draft: Point;
    /** Feed engagement, in the row under a thread. */
    like: Point;
    repost: Point;
    follow: Point;
    swipe: {
        x: number;
        startY: number;
        endY: number;
        durationMs: number;
    };
}

export const DEFAULT_COORDINATE_PROFILE = 'iphone8';

// Add another named layout here, then set that key as coordinateProfile on
// the matching devices.json entry. Devices without a key use iphone8.
export const DEVICE_COORDINATES = {
    iphone8: {
        displayName: 'iPhone 8',
        productTypes: ['iPhone10,1', 'iPhone10,4'],
        screenSize: { width: 375, height: 667 },
        passcodeKeypad: {
            columnX: [103, 191, 275],
            rowY: [220, 347, 425, 506],
        },
        tiktok: {
            profileTab: { x: 338, y: 656 },
            homeTab: { x: 38, y: 653 },
            accountSwitcher: { x: 185, y: 158 },
            create: { x: 187, y: 640 },
            upload: { x: 30, y: 635 },
            selectMultiple: { x: 24, y: 618 },
            useLayout: { x: 24, y: 489 },
            photoTab: { x: 244, y: 62 },
            photoModeToggle: { x: 96, y: 566 },
            photoTemplateSkip: { x: 335, y: 62 },
            picker: {
                circleX: 106,
                columnStep: 126,
                firstY: 482,
                trayY: 360,
                rowStep: 125,
                cellX: 62,
                cellStep: 125,
                cellY: 526,
            },
            pickerNext: { x: 277, y: 617 },
            editorNext: { x: 277, y: 637 },
            caption: { x: 120, y: 236 },
            keyboardBack: { x: 22, y: 42 },
            draft: { x: 98, y: 630 },
            finish: { x: 277, y: 630 },
            like: { x: 345, y: 313 },
            save: { x: 345, y: 444 },
            swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
        // UNVERIFIED. Not one of these has been checked against an iPhone.
        instagram: {
            homeTab: { x: 38, y: 653 },
            reelsTab: { x: 262, y: 653 },
            profileTab: { x: 338, y: 656 },
            accountSwitcher: { x: 130, y: 60 },
            create: { x: 187, y: 653 },
            postTab: { x: 150, y: 640 },
            reelTab: { x: 225, y: 640 },
            selectMultiple: { x: 60, y: 330 },
            picker: { cellX: 62, cellStep: 125, cellY: 420, rowStep: 125 },
            pickerNext: { x: 340, y: 60 },
            editorNext: { x: 340, y: 60 },
            caption: { x: 180, y: 120 },
            keyboardBack: { x: 22, y: 42 },
            draft: { x: 187, y: 400 },
            share: { x: 187, y: 620 },
            like: { x: 30, y: 470 },
            save: { x: 345, y: 470 },
            swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
        // UNVERIFIED. Reasoned from the 375x667 layout, never measured on a phone.
        youtube: {
            homeTab: { x: 38, y: 653 },
            shortsTab: { x: 112, y: 653 },
            accountAvatar: { x: 350, y: 40 },
            create: { x: 187, y: 650 },
            upload: { x: 187, y: 560 },
            firstCell: { x: 62, y: 300 },
            next: { x: 330, y: 42 },
            titleField: { x: 187, y: 150 },
            descriptionField: { x: 187, y: 210 },
            keyboardBack: { x: 22, y: 42 },
            visibility: { x: 187, y: 300 },
            publicOption: { x: 187, y: 360 },
            audience: { x: 187, y: 360 },
            notMadeForKids: { x: 187, y: 420 },
            uploadShort: { x: 300, y: 630 },
            saveDraft: { x: 75, y: 630 },
            like: { x: 350, y: 380 },
            subscribe: { x: 300, y: 560 },
            comment: { x: 350, y: 440 },
            commentField: { x: 160, y: 600 },
            commentSend: { x: 350, y: 600 },
            swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
        // GUESS, every value: Threads has never been opened on hardware from this repository.
        threads: {
            homeTab: { x: 38, y: 653 },
            profileTab: { x: 338, y: 653 },
            accountSwitcher: { x: 187, y: 120 },
            compose: { x: 262, y: 653 },
            attach: { x: 40, y: 300 },
            composerField: { x: 187, y: 180 },
            pickerFirstCell: { x: 62, y: 420 },
            pickerColumnStep: 125,
            pickerRowStep: 125,
            pickerAdd: { x: 320, y: 620 },
            keyboardDone: { x: 340, y: 120 },
            post: { x: 330, y: 630 },
            draft: { x: 40, y: 60 },
            like: { x: 60, y: 470 },
            repost: { x: 140, y: 470 },
            follow: { x: 330, y: 200 },
            swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
    },
} satisfies Record<string, DeviceCoordinates>;

export type CoordinateProfile = keyof typeof DEVICE_COORDINATES;
export type DeviceProfileName = CoordinateProfile;
export const DEFAULT_DEVICE_PROFILE = DEFAULT_COORDINATE_PROFILE;

export interface CoordinateProfileSummary {
    name: CoordinateProfile;
    displayName: string;
    productTypes: readonly string[];
    screenSize: DeviceCoordinates['screenSize'];
}

export function coordinateProfiles(): CoordinateProfileSummary[] {
    return Object.entries(DEVICE_COORDINATES).map(([name, coordinates]) => ({
        name: name as CoordinateProfile,
        displayName: coordinates.displayName,
        productTypes: [...coordinates.productTypes],
        screenSize: { ...coordinates.screenSize },
    }));
}

export function profileForProductType(productType: string | undefined): CoordinateProfile | undefined {
    if (!productType) return;
    return coordinateProfiles().find(({ productTypes }) => productTypes.includes(productType))?.name;
}

export function modelNameForProductType(productType: string | undefined): string | undefined {
    if (!productType) return;
    return coordinateProfiles().find(({ productTypes }) => productTypes.includes(productType))?.displayName;
}

export function coordinatesForProfile(profile: string = DEFAULT_COORDINATE_PROFILE): DeviceCoordinates {
    if (!(profile in DEVICE_COORDINATES)) {
        throw new Error(`Unknown coordinate profile "${profile}". Add it to src/devices/coordinates.ts.`);
    }
    return DEVICE_COORDINATES[profile as CoordinateProfile];
}

// The single-tap TikTok targets an operator can re-point from the dashboard.
// (picker grid, swipe vector and the passcode keypad are not single points and
// stay profile-level for now. The `instagram` section is profile-level in its
// entirety — calibrate it by editing the profile until there is a real layout
// worth exposing in the dashboard's calibration dialog.)
export const CALIBRATABLE_POINTS = [
    'profileTab', 'homeTab', 'accountSwitcher', 'create', 'upload', 'selectMultiple', 'useLayout',
    'photoTab', 'photoModeToggle', 'photoTemplateSkip',
    'pickerNext', 'editorNext', 'caption', 'keyboardBack', 'draft', 'finish', 'like', 'save',
] as const;

export type CalibratablePoint = typeof CALIBRATABLE_POINTS[number];

export const POINT_LABELS: Record<CalibratablePoint, string> = {
    profileTab: 'TikTok: Profile tab', homeTab: 'TikTok: Home tab', accountSwitcher: 'TikTok: Account switcher',
    create: 'TikTok: Create (+)', upload: 'TikTok: Upload', selectMultiple: 'TikTok: Select multiple', useLayout: 'TikTok: Use layout',
    photoTab: 'TikTok: Picker · Photos tab', photoModeToggle: 'TikTok: Editor · Photo mode',
    photoTemplateSkip: 'TikTok: Photo templates · Skip',
    pickerNext: 'TikTok: Media picker · Next', editorNext: 'TikTok: Editor · Next', caption: 'TikTok: Caption field',
    keyboardBack: 'TikTok: Keyboard · back', draft: 'TikTok: Save draft', finish: 'TikTok: Post / Finish',
    like: 'TikTok: Like button', save: 'TikTok: Save/bookmark button',
};

/** Per-device overrides for the calibratable points, stored on the devices.json entry. */
export type DeviceCoordinateOverrides = Partial<Record<CalibratablePoint, Point>>;

/** The profile's coordinates with any per-device single-tap overrides applied. */
export function resolveDeviceCoordinates(
    profile: string | undefined,
    overrides: DeviceCoordinateOverrides | undefined,
): DeviceCoordinates {
    const base = coordinatesForProfile(profile);
    if (!overrides) return base;
    const tiktok = { ...base.tiktok };
    for (const name of CALIBRATABLE_POINTS) {
        const point = overrides[name];
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            tiktok[name] = { x: Math.round(point.x), y: Math.round(point.y) };
        }
    }
    return { ...base, tiktok };
}

/** Validate an override map: known keys only, integer points within the profile's screen. */
export function validateCoordinateOverrides(
    value: unknown,
    profile: string | undefined,
): DeviceCoordinateOverrides {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('coordinates must be an object');
    const { width, height } = coordinatesForProfile(profile).screenSize;
    const result: DeviceCoordinateOverrides = {};
    for (const [key, point] of Object.entries(value as Record<string, unknown>)) {
        if (!CALIBRATABLE_POINTS.includes(key as CalibratablePoint)) throw new Error(`Unknown calibratable point "${key}"`);
        if (!point || typeof point !== 'object') throw new Error(`${key} must be a {x, y} point`);
        const { x, y } = point as { x: unknown; y: unknown };
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`${key} x and y must be numbers`);
        }
        if (x < 0 || y < 0 || x > width || y > height) {
            throw new Error(`${key} (${x}, ${y}) is outside the ${width}×${height} screen`);
        }
        result[key as CalibratablePoint] = { x: Math.round(x), y: Math.round(y) };
    }
    return result;
}
