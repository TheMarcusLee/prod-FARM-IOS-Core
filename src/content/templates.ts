/**
 * A deliberately tiny caption templating language. Two things only:
 *
 *   {title} {hashtags} {account} {date}   — variable substitution
 *   {random:a|b|c}                        — spintax; one branch is picked
 *
 * An unknown `{token}` is left verbatim so a typo shows up in the rendered
 * caption instead of silently vanishing from a public post.
 */

export interface CaptionVariables {
    title?: string;
    hashtags?: string[] | string;
    account?: string;
    date?: string;
}

const TOKEN = /\{([^{}]*)\}/g;

function hashtagText(value: string[] | string | undefined): string {
    if (value === undefined) return '';
    const list = Array.isArray(value) ? value : value.split(/[\s,]+/);
    return list
        .map((tag) => tag.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .map((tag) => `#${tag}`)
        .join(' ');
}

/** Splits `a|b|c` respecting nothing — branches cannot themselves contain braces. */
export function spintaxBranches(body: string): string[] {
    return body.split('|').map((branch) => branch.trim());
}

export function renderCaptionTemplate(
    template: string,
    variables: CaptionVariables = {},
    random: () => number = Math.random,
): string {
    const values: Record<string, string> = {
        title: variables.title ?? '',
        hashtags: hashtagText(variables.hashtags),
        account: variables.account ?? '',
        date: variables.date ?? '',
    };
    const rendered = template.replace(TOKEN, (match, rawToken: string) => {
        const token = rawToken.trim();
        if (token.startsWith('random:')) {
            const branches = spintaxBranches(token.slice('random:'.length));
            if (!branches.length) return '';
            const index = Math.min(branches.length - 1, Math.max(0, Math.floor(random() * branches.length)));
            return branches[index] ?? '';
        }
        const key = token.toLowerCase();
        return key in values ? values[key] as string : match;
    });
    // Substituting an empty variable regularly leaves double spaces and a
    // trailing blank line; a caption is user-visible, so tidy it.
    return rendered.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** TikTok's caption limit, mirrored from the plugin's own validation. */
export const CAPTION_MAX_LENGTH = 2200;

export function clampCaption(caption: string): string {
    return caption.length <= CAPTION_MAX_LENGTH ? caption : caption.slice(0, CAPTION_MAX_LENGTH);
}
