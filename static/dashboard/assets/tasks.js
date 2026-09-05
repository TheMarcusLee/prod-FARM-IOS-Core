/**
 * The Tasks page became the Schedule timeline. `/tasks` redirects server-side; this stub only
 * covers the case where the retired template is served from cache. See static/dashboard/ts/schedule.ts.
 */
if (location.pathname === '/tasks')
    location.replace('/schedule');
export {};
