// ==UserScript==
// @name         Reviewer Wizard
// @namespace    https://burnsmcd.com
// @version      1.3
// @author       Josue Gutierrez
// @description  Per-project reviewer wizard for SDx: fast fuzzy search, favorites, existing-recipient awareness, batched bulk add, and batch add to multiple To Do List documents.
// @match        https://*/enr01/*
// @match        https://*/ENR01/*
// @grant        none
// @downloadURL https://raw.githubusercontent.com/JGtz-BMcD/SDx-Add-Reviewer/main/SDx-Add-Reviewer.user.js
// @updateURL https://raw.githubusercontent.com/JGtz-BMcD/SDx-Add-Reviewer/main/SDx-Add-Reviewer.user.js
// ==/UserScript==
(function () {
    "use strict";
    const VERSION = "1.3";
    const TOOL_NAME = "Reviewer Wizard";
    const WIZARD_ICON = "\u{1FA84}"; // magic wand
    const PAGE_SIZE = 100;
    const DEFAULT_SELECTED_ORGS = ["Burns & McDonnell"];
    const IDS = {
        style: "sdxbr_style_v13",
        button: "sdxbr_button_v13",
        modal: "sdxbr_modal_v13",
        backdrop: "sdxbr_backdrop_v13"
    };
    // Storage keys are unchanged from v0.7 on purpose - this release is UI/perf
    // tweaks only, so existing per-project databases, favorites, and recents all
    // carry over without needing to be rebuilt.
    const STORE = {
        recentsPrefix: "sdxbr_recents_v07_",
        favoritesPrefix: "sdxbr_favorites_v07_",
        authHeaders: "sdxbr_auth_headers_v07",
        userCachePrefix: "sdxbr_user_cache_v07_",
        orgIndexPrefix: "sdxbr_org_index_v07_",
        selectedOrgsPrefix: "sdxbr_selected_orgs_v07_",
        pageContextPrefix: "sdxbr_page_context_v07_",
        lastAddTemplatePrefix: "sdxbr_last_add_template_v13_"
    };
    const BATCH_BTN_ID = "sdxbr_batch_button_v13";
    const TODO_CHECKBOX_SELECTOR = 'input[type="checkbox"].mdc-checkbox__native-control';
    const state = {
        hooksInstalled: false,
        lastHref: "",
        projectKey: "unknown",
        pageKey: "",
        documentOBID: null,
        selectedOrgs: new Set(DEFAULT_SELECTED_ORGS),
        orgIndex: new Map(),
        userCache: new Map(),
        searchResults: [],
        queued: new Map(),
        addedThisPage: new Map(),
        existingRecipients: new Map(),
        existingRecipientsStatus: "idle",
        activeTab: "reviewers",
        orgSelectionDirty: false,
        showRefreshPrompt: false,
        addEndpoint: null,
        lastWorkflowSearchUrl: null,
        lastWorkflowSearchParams: null,
        addTemplate: {
            workFlowStepOBIDs: [],
            userOBIDs: [],
            workFlowTemplateName: "HEX QA Append Reviewer Workflow",
            stepDefName: "SCLBProjComsPerformReview",
            relDefUID: ""
        },
        authHeaders: {},
        authStale: false,
        busy: false,
        dbBusy: false,
        // Batch mode (To Do List): add the same reviewers to several selected
        // workflow steps at once. `existing` is docId -> { status, users }.
        batch: {
            active: false,
            docs: [],
            existing: new Map(),
            results: null,
            detailsOpen: false,
            selection: [],
            lastChecked: -1
        }
    };
    /************************************************************
     * Utilities
     ************************************************************/
    class AuthError extends Error {}
    function log(...args) {
        console.log(`%c${WIZARD_ICON} [${TOOL_NAME} v${VERSION}]`, "color:#0078d4;font-weight:bold", ...args);
    }
    function warn(...args) {
        console.warn(`%c${WIZARD_ICON} [${TOOL_NAME} v${VERSION}]`, "color:#c77d00;font-weight:bold", ...args);
    }
    function err(...args) {
        console.error(`%c${WIZARD_ICON} [${TOOL_NAME} v${VERSION}]`, "color:#c00000;font-weight:bold", ...args);
    }
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    function debounce(fn, wait) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    }
    function safeJsonParse(text, fallback = null) {
        try {
            return JSON.parse(text);
        } catch {
            return fallback;
        }
    }
    function readJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch {
            return fallback;
        }
    }
    function writeJson(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            warn("localStorage write failed:", key, e);
            setStatus(`Could not save data locally (storage may be full): ${key}`, true);
            return false;
        }
    }
    function removeJson(key) {
        try {
            localStorage.removeItem(key);
        } catch {}
    }
    function normalize(value) {
        return String(value || "").trim().toLowerCase();
    }
    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    // Word-boundary route matching so "#/review" never accidentally matches
    // something like "#/preview".
    function hashRouteIs(name) {
        const hash = location.hash || "";
        const prefix = "#/" + name;
        if (!hash.toLowerCase().startsWith(prefix.toLowerCase())) return false;
        const rest = hash.slice(prefix.length);
        return rest === "" || rest.startsWith(";") || rest.startsWith("?");
    }
    function isAddRecipientPage() {
        return hashRouteIs("add-recipient");
    }
    function isReviewPage() {
        return hashRouteIs("review");
    }
    function isDocumentPage() {
        return isAddRecipientPage() || isReviewPage();
    }
    function isSdxPage() {
        return location.href.toLowerCase().includes("/enr01/");
    }
    function getProjectKeyFromPage() {
        const href = location.href;
        const queryFilterMatch = href.match(/queryFilter=([^;]+)/i);
        if (queryFilterMatch) {
            try {
                const decoded = decodeURIComponent(queryFilterMatch[1]);
                const parsed = JSON.parse(decoded);
                if (parsed?.config?.key) return parsed.config.key;
                if (parsed?.config?.value) return parsed.config.value;
            } catch {}
        }
        const configMatch = href.match(/config=([^;]+)/i);
        if (configMatch) {
            try {
                const decoded = decodeURIComponent(configMatch[1]);
                const parsed = JSON.parse(decoded);
                if (Array.isArray(parsed) && parsed.length) return parsed.join("_");
            } catch {}
        }
        // Last resort only - reading innerText forces the browser to compute the
        // full rendered text of the page, which is expensive on big grids. This
        // path is now only reached at most once per real navigation (see the
        // href-diff guard in activateIfNeeded), never on a steady-state poll.
        const text = document.body?.innerText || "";
        const queryMatch = text.match(/Query\s+(\d+)/i);
        if (queryMatch) return queryMatch[1];
        const createMatch = text.match(/Create\s+(\d+)/i);
        if (createMatch) return createMatch[1];
        return "unknown";
    }
    function getPageKeyFromUrl() {
        try {
            const u = new URL(location.href);
            return [
                u.origin,
                u.pathname.toLowerCase(),
                u.hash.split(";")[0],
                u.hash.match(/ContextObjectOBIDs=[^;]+/i)?.[0] || "",
                u.hash.match(/MethodOBID=[^;]+/i)?.[0] || "",
                u.hash.match(/config=[^;]+/i)?.[0] || ""
            ].join("|");
        } catch {
            return location.href;
        }
    }
    // The document's own object ID, read straight from the URL. Confirmed across
    // several documents that this is the same value the native app uses as the
    // workflow step OBID for both Add Recipients and Review, so we no longer need
    // to wait for (or trigger) any native search to learn it.
    function getContextObjectOBIDs() {
        try {
            const match = location.hash.match(/ContextObjectOBIDs=([^;]+)/i);
            if (!match) return [];
            const decoded = decodeURIComponent(match[1]).replace(/'/g, '"');
            const parsed = JSON.parse(decoded);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
            if (typeof parsed === "string" && parsed) return [parsed];
        } catch {}
        return [];
    }
    function storeKey(prefix) {
        return prefix + state.projectKey;
    }
    function pageContextKey() {
        return STORE.pageContextPrefix + state.pageKey;
    }
    function getUserId(user) {
        return user?.Id || user?.OBID || "";
    }
    function getUserName(user) {
        return user?.Name || user?.Login_Name || user?.UID || user?.Id || "Unknown User";
    }
    function getUserLogin(user) {
        return user?.Login_Name || user?.UID || "";
    }
    function getUserEmail(user) {
        return user?.Email_ID || user?.Email || "";
    }
    function getUserOrg(user) {
        return user?.Organization || "";
    }
    function getUserRoles(user) {
        return user?.Roles || "";
    }
    function getUserMeta(user) {
        const pieces = [];
        if (getUserLogin(user)) pieces.push(getUserLogin(user));
        if (getUserEmail(user)) pieces.push(getUserEmail(user));
        if (getUserOrg(user)) pieces.push(getUserOrg(user));
        if (getUserId(user)) pieces.push("Id: " + getUserId(user));
        return pieces.join(" | ");
    }
    // Trimmed line used in the compact list panels (Favorites / Search Results /
    // Queue / Recents) - just the organization, no email or login name, so a
    // dozen-plus favorites still fit without a wall of text.
    function getUserMetaShort(user) {
        return getUserOrg(user) || "No organization on file";
    }
    function normalizeUser(raw) {
        if (!raw) return null;
        const id = raw.Id || raw.OBID || raw.OBID1;
        if (!id) return null;
        return {
            Id: id,
            UID: raw.UID || "",
            Name: raw.Name || raw.CI_Name || "",
            Login_Name: raw.Login_Name || raw.LoginName || "",
            Email_ID: raw.Email_ID || raw.Email || "",
            Organization: raw.Organization || "",
            Roles: raw.Roles || "",
            Configs: raw.Configs || raw.Config || "",
            Group_Indicator: raw.Group_Indicator ?? null
        };
    }
    function resolveUserById(id) {
        if (!id) return null;
        return (
            state.userCache.get(id) ||
            state.queued.get(id) ||
            state.searchResults.find(u => getUserId(u) === id) ||
            normalizeUser(readJson(storeKey(STORE.recentsPrefix), []).find(u => u && u.Id === id)) ||
            normalizeUser(getFavorites().find(u => u && u.Id === id)) ||
            null
        );
    }
    /************************************************************
     * Storage
     ************************************************************/
    // Reloads the (potentially large) per-project reviewer database, org index,
    // and org selection from storage. This does a JSON.parse over the whole
    // cached user list, which can be a meaningful chunk of work if a project's
    // database has thousands of entries - so it should only run when the
    // PROJECT actually changes or the tool is explicitly opened, never on every
    // document navigation within the same project (see activateIfNeeded below;
    // that was a real bug in v0.8 that re-parsed the whole cache on every single
    // document you opened, which is a very plausible source of the slowdown).
    function loadProjectScopedState() {
        state.selectedOrgs = new Set(readJson(storeKey(STORE.selectedOrgsPrefix), DEFAULT_SELECTED_ORGS));
        if (!state.selectedOrgs.size) {
            state.selectedOrgs = new Set(DEFAULT_SELECTED_ORGS);
        }
        state.orgIndex.clear();
        const orgs = readJson(storeKey(STORE.orgIndexPrefix), []);
        for (const item of orgs) {
            if (item && item.name) state.orgIndex.set(item.name, item.count || 0);
        }
        state.userCache.clear();
        const users = readJson(storeKey(STORE.userCachePrefix), []);
        for (const raw of users) {
            const user = normalizeUser(raw);
            if (user) state.userCache.set(user.Id, user);
        }
    }
    function loadStoredState() {
        state.projectKey = getProjectKeyFromPage();
        state.pageKey = getPageKeyFromUrl();
        loadProjectScopedState();
        loadAuthHeaders();
        loadPageContext();
    }
    function saveSelectedOrgs() {
        writeJson(storeKey(STORE.selectedOrgsPrefix), Array.from(state.selectedOrgs).sort());
    }
    function saveOrgIndex() {
        const data = Array.from(state.orgIndex.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name));
        writeJson(storeKey(STORE.orgIndexPrefix), data);
    }
    function saveUserCache() {
        const data = Array.from(state.userCache.values())
            .sort((a, b) => getUserName(a).localeCompare(getUserName(b)));
        writeJson(storeKey(STORE.userCachePrefix), data);
    }
    function clearUserCache() {
        if (!confirm(`Clear the reviewer database for project ${state.projectKey}? Other projects are not affected.`)) return;
        state.userCache.clear();
        state.searchResults = [];
        removeJson(storeKey(STORE.userCachePrefix));
        renderAll();
        setStatus("Reviewer database cleared for this project. Rebuild from the User Database tab.", true);
    }
    /************************************************************
     * Favorites and Recents (scoped per project)
     ************************************************************/
    function getFavorites() {
        return readJson(storeKey(STORE.favoritesPrefix), []);
    }
    function isFavorite(id) {
        return getFavorites().some(f => f && f.Id === id);
    }
    function toggleFavorite(id) {
        const user = resolveUserById(id);
        if (!user) {
            setStatus("Could not find that user to favorite.", true);
            return;
        }
        let favorites = getFavorites();
        if (favorites.some(f => f && f.Id === id)) {
            favorites = favorites.filter(f => f && f.Id !== id);
            setStatus(`Removed ${getUserName(user)} from favorites for this project.`);
        } else {
            favorites = favorites.filter(f => f && f.Id !== id);
            favorites.unshift({
                Id: user.Id,
                Name: getUserName(user),
                Login_Name: getUserLogin(user),
                Email_ID: getUserEmail(user),
                Organization: getUserOrg(user)
            });
            setStatus(`Added ${getUserName(user)} to favorites for this project.`);
        }
        writeJson(storeKey(STORE.favoritesPrefix), favorites.slice(0, 300));
        renderAll();
    }
    function queueFavorite(id) {
        const favorites = getFavorites();
        const found = favorites.find(f => f && f.Id === id);
        if (!found) return;
        const user = normalizeUser(found);
        if (!user) return;
        state.userCache.set(user.Id, user);
        queueUser(user.Id);
    }
    function saveRecent(user) {
        const recents = readJson(storeKey(STORE.recentsPrefix), []);
        const cleaned = recents.filter(x => x && x.Id !== user.Id);
        cleaned.unshift({
            Id: user.Id,
            Name: getUserName(user),
            Login_Name: getUserLogin(user),
            Email_ID: getUserEmail(user),
            Organization: getUserOrg(user)
        });
        writeJson(storeKey(STORE.recentsPrefix), cleaned.slice(0, 30));
    }
    function queueRecent(id) {
        const recents = readJson(storeKey(STORE.recentsPrefix), []);
        const found = recents.find(x => x.Id === id);
        if (!found) return;
        const user = normalizeUser(found);
        if (!user) return;
        state.userCache.set(user.Id, user);
        queueUser(user.Id);
    }
    /************************************************************
     * Headers, Session Capture, and Network Capture
     ************************************************************/
    function headersToObject(headers) {
        const obj = {};
        try {
            if (!headers) return obj;
            if (headers instanceof Headers) {
                headers.forEach((value, key) => {
                    obj[String(key).toLowerCase()] = value;
                });
                return obj;
            }
            if (Array.isArray(headers)) {
                for (const [key, value] of headers) {
                    obj[String(key).toLowerCase()] = value;
                }
                return obj;
            }
            for (const key of Object.keys(headers)) {
                obj[String(key).toLowerCase()] = headers[key];
            }
        } catch {}
        return obj;
    }
    function loadAuthHeaders() {
        const saved = readJson(STORE.authHeaders, null);
        if (saved && typeof saved === "object") {
            state.authHeaders = { ...saved };
        }
    }
    function persistAuthHeaders() {
        writeJson(STORE.authHeaders, state.authHeaders);
    }
    // ---- Token freshness (ported from SDx QoL) ----
    // SDx renews its session token while you work and the renewed one isn't
    // always the one we captured first. Compare JWT expiry so a stale token is
    // never preferred over a newer one, and fall back to sessionStorage when the
    // captured token has expired.
    function stripBearer(value) {
        return String(value || "").replace(/^Bearer\s+/i, "").trim();
    }
    function looksLikeJwt(value) {
        return typeof value === "string" && value.split(".").length === 3;
    }
    function jwtExpiryMs(token) {
        try {
            const part = String(token).split(".")[1];
            const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
            const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
            const exp = Number(JSON.parse(json).exp);
            return Number.isFinite(exp) ? exp * 1000 : 0;
        } catch {
            return 0;
        }
    }
    function getSessionStorageTokens() {
        const found = [];
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (!key || !/auth/i.test(key)) continue;
                const raw = sessionStorage.getItem(key);
                if (!raw) continue;
                try {
                    const parsed = JSON.parse(raw);
                    const candidate = parsed && (parsed.authorization || parsed.Authorization || parsed.accessToken || parsed.access_token || parsed.token);
                    if (typeof candidate === "string") {
                        const stripped = stripBearer(candidate);
                        if (looksLikeJwt(stripped)) found.push(stripped);
                    }
                } catch {
                    const stripped = stripBearer(raw);
                    if (looksLikeJwt(stripped)) found.push(stripped);
                }
            }
        } catch {}
        return found;
    }
    // Returns "Bearer <token>". Normal use: keep the captured token unless it is
    // missing/expired. forceFreshest (used on a 401 retry): latest expiry wins.
    function getBestAuthorization(forceFreshest = false) {
        const captured = stripBearer(state.authHeaders.authorization);
        const all = [captured, ...getSessionStorageTokens()].filter(Boolean);
        if (!all.length) return "";
        const now = Date.now();
        if (!forceFreshest && captured) {
            const exp = jwtExpiryMs(captured);
            if (exp === 0 || exp > now + 30000) return "Bearer " + captured;
        }
        let best = all[0];
        let bestExp = jwtExpiryMs(best);
        for (const token of all) {
            const exp = jwtExpiryMs(token);
            if (exp > bestExp) {
                best = token;
                bestExp = exp;
            }
        }
        return "Bearer " + best;
    }
    // Broadened on purpose: rather than only watching the endpoints this tool calls
    // directly, grab the bearer token off of ANY same-origin SDx API call the
    // native app makes. In practice, almost any click inside SDx keeps the
    // captured session fresh instead of requiring one specific native search.
    function isCandidateSdxApiUrl(urlStr) {
        try {
            const u = new URL(urlStr, location.origin);
            if (u.origin !== location.origin) return false;
            return u.pathname.toLowerCase().includes("/api/");
        } catch {
            return false;
        }
    }
    function rememberHeaders(headers) {
        const h = headersToObject(headers);
        let changed = false;
        if (h.authorization && h.authorization !== state.authHeaders.authorization) {
            // Only replace the stored token with one that expires at least as
            // late (an unreadable expiry counts as 0, so it never beats a good one).
            const newExp = jwtExpiryMs(stripBearer(h.authorization));
            const oldExp = jwtExpiryMs(stripBearer(state.authHeaders.authorization));
            if (!state.authHeaders.authorization || newExp >= oldExp) {
                state.authHeaders.authorization = h.authorization;
                changed = true;
            }
        }
        if (h.accept) state.authHeaders.accept = h.accept;
        if (h["accept-language"]) state.authHeaders["accept-language"] = h["accept-language"];
        if (h["content-type"]) state.authHeaders["content-type"] = h["content-type"];
        if (changed) {
            state.authHeaders.capturedAt = new Date().toISOString();
            state.authStale = false;
            persistAuthHeaders();
            updateSessionIndicator();
            log("Captured a fresh session token.");
        }
    }
    function getApiHeaders() {
        const headers = {
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json"
        };
        const bestAuth = getBestAuthorization();
        if (bestAuth) {
            headers.authorization = bestAuth;
        }
        if (state.authHeaders["accept-language"]) {
            headers["accept-language"] = state.authHeaders["accept-language"];
        }
        // Explicitly scope every request this tool makes to the detected project,
        // matching what SDx itself sends on native calls. Extra safety net against
        // ever touching the wrong project's data, on top of per-project caching.
        if (state.projectKey && state.projectKey !== "unknown") {
            headers["SPFCreateConfigUID"] = state.projectKey;
            headers["SPFQueryConfigUID"] = state.projectKey;
        }
        return headers;
    }
    // Wraps fetch calls this tool makes on its own (not the native app's calls).
    // If SDx comes back with 401/403 the captured token is stale - mark it,
    // surface it in the UI, and stop instead of failing silently.
    async function apiFetch(url, options) {
        let response = await fetch(url, options);
        if (response.status === 401) {
            // Token may simply be stale: retry once with the freshest one we can see.
            const fresh = getBestAuthorization(true);
            const used = options?.headers?.authorization || "";
            if (fresh && fresh !== used) {
                response = await fetch(url, {
                    ...options,
                    headers: { ...(options?.headers || {}), authorization: fresh }
                });
            }
        }
        if (response.status === 401 || response.status === 403) {
            state.authStale = true;
            updateSessionIndicator();
            let bodyText = "";
            try { bodyText = await response.text(); } catch {}
            throw new AuthError(
                `Session expired or not captured yet (HTTP ${response.status}). Click any filter or search inside SDx once, then retry. ${bodyText}`.trim()
            );
        }
        return response;
    }
    function getFetchInfo(args) {
        const input = args[0];
        const init = args[1] || {};
        let url = "";
        let method = "GET";
        let headers = {};
        let body = null;
        try {
            if (input instanceof Request) {
                url = input.url;
                method = input.method || method;
                headers = headersToObject(input.headers);
            } else {
                url = String(input || "");
            }
            if (init.method) method = init.method;
            if (init.headers) headers = { ...headers, ...headersToObject(init.headers) };
            if (init.body) body = init.body;
        } catch {}
        return {
            url,
            method: String(method || "GET").toUpperCase(),
            headers,
            body
        };
    }
    function parseWorkflowSteps(raw) {
        if (!raw) return [];
        const attempts = [
            raw,
            decodeURIComponent(raw),
            raw.replace(/'/g, "\""),
            decodeURIComponent(raw).replace(/'/g, "\"")
        ];
        for (const attempt of attempts) {
            try {
                const parsed = JSON.parse(attempt);
                if (Array.isArray(parsed)) return parsed;
            } catch {}
        }
        return [];
    }
    function cleanQuoted(value) {
        return String(value || "").trim().replace(/^'/, "").replace(/'$/, "");
    }
    function captureWorkflowSearchContext(url) {
        if (!isDocumentPage()) return;
        try {
            const absolute = new URL(url, location.origin);
            const lower = absolute.pathname.toLowerCase();
            if (!lower.includes("/api/v2/sda/getusersforworkflowsteps")) return;
            const currentPageKey = getPageKeyFromUrl();
            if (currentPageKey !== state.pageKey) {
                state.pageKey = currentPageKey;
                resetPerDocumentPage();
            }
            state.lastWorkflowSearchUrl = absolute.toString();
            state.lastWorkflowSearchParams = new URLSearchParams(absolute.search);
            const wfRaw = state.lastWorkflowSearchParams.get("WorkFlowStepOBIDs");
            const stepRaw = state.lastWorkflowSearchParams.get("StepDefName");
            const steps = parseWorkflowSteps(wfRaw);
            if (steps.length) state.addTemplate.workFlowStepOBIDs = steps;
            if (stepRaw) state.addTemplate.stepDefName = cleanQuoted(stepRaw);
            state.addEndpoint = absolute.origin + absolute.pathname.replace("GetUsersForWorkflowSteps", "AddRecipients");
            savePageContext();
            renderContextPanel();
            updateStatus();
            log("Captured Add Recipients context from native call:", state.addTemplate.workFlowStepOBIDs);
        } catch (e) {
            warn("Failed to capture workflow context:", e);
        }
    }
    function captureAddContext(url, body) {
        if (!isDocumentPage()) return;
        try {
            const absolute = new URL(url, location.origin);
            const lower = absolute.pathname.toLowerCase();
            if (!lower.includes("/api/v2/sda/addrecipients")) return;
            const currentPageKey = getPageKeyFromUrl();
            if (currentPageKey !== state.pageKey) {
                state.pageKey = currentPageKey;
                resetPerDocumentPage();
            }
            state.addEndpoint = absolute.toString();
            let parsed = null;
            if (typeof body === "string") parsed = safeJsonParse(body);
            else if (body && typeof body === "object") parsed = body;
            if (parsed) {
                state.addTemplate = {
                    ...state.addTemplate,
                    ...parsed,
                    userOBIDs: []
                };
                // Remember the workflow fields per project so batch mode (which
                // has no single document page to read them from) can reuse them.
                writeJson(storeKey(STORE.lastAddTemplatePrefix), {
                    workFlowTemplateName: parsed.workFlowTemplateName || "",
                    stepDefName: parsed.stepDefName || "",
                    relDefUID: parsed.relDefUID || ""
                });
            }
            savePageContext();
            renderContextPanel();
            updateStatus();
            log("Captured AddRecipients context from native call:", state.addTemplate.workFlowStepOBIDs);
        } catch (e) {
            warn("Failed to capture AddRecipients context:", e);
        }
    }
    function installNetworkHooks() {
        if (state.hooksInstalled || window.__sdxbr_v13_hooks) return;
        state.hooksInstalled = true;
        window.__sdxbr_v13_hooks = true;
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const info = getFetchInfo(args);
            try {
                if (isCandidateSdxApiUrl(info.url)) {
                    rememberHeaders(info.headers);
                }
                const lower = info.url.toLowerCase();
                if (lower.includes("/api/v2/sda/getusersforworkflowsteps")) {
                    captureWorkflowSearchContext(info.url);
                }
                if (lower.includes("/api/v2/sda/addrecipients")) {
                    captureAddContext(info.url, info.body);
                }
            } catch (e) {
                warn("Fetch capture failed:", e);
            }
            return originalFetch.apply(this, args);
        };
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function (method, url) {
            this.__sdxbr_v13_url = url;
            this.__sdxbr_v13_headers = {};
            return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
            try {
                this.__sdxbr_v13_headers[String(key).toLowerCase()] = value;
            } catch {}
            return originalSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            try {
                const url = this.__sdxbr_v13_url || "";
                if (isCandidateSdxApiUrl(url)) {
                    rememberHeaders(this.__sdxbr_v13_headers);
                }
                const lower = String(url).toLowerCase();
                if (lower.includes("/api/v2/sda/getusersforworkflowsteps")) {
                    captureWorkflowSearchContext(url);
                }
                if (lower.includes("/api/v2/sda/addrecipients")) {
                    captureAddContext(url, body);
                }
            } catch (e) {
                warn("XHR capture failed:", e);
            }
            return originalSend.apply(this, arguments);
        };
        log("Network hooks installed (broad session capture active).");
    }
    /************************************************************
     * Page / Document Context
     ************************************************************/
    function savePageContext() {
        writeJson(pageContextKey(), {
            pageKey: state.pageKey,
            addEndpoint: state.addEndpoint,
            lastWorkflowSearchUrl: state.lastWorkflowSearchUrl,
            addTemplate: {
                ...state.addTemplate,
                userOBIDs: []
            },
            savedAt: new Date().toISOString()
        });
    }
    function loadPageContext() {
        const saved = readJson(pageContextKey(), null);
        if (!saved || saved.pageKey !== state.pageKey) return;
        state.addEndpoint = saved.addEndpoint || null;
        state.lastWorkflowSearchUrl = saved.lastWorkflowSearchUrl || null;
        if (state.lastWorkflowSearchUrl) {
            try {
                state.lastWorkflowSearchParams = new URLSearchParams(new URL(state.lastWorkflowSearchUrl).search);
            } catch {}
        }
        if (saved.addTemplate) {
            state.addTemplate = {
                ...state.addTemplate,
                ...saved.addTemplate,
                userOBIDs: []
            };
        }
    }
    function resetPerDocumentPage() {
        state.queued.clear();
        state.addedThisPage.clear();
        state.searchResults = [];
        state.addEndpoint = null;
        state.lastWorkflowSearchUrl = null;
        state.lastWorkflowSearchParams = null;
        state.documentOBID = null;
        state.existingRecipients.clear();
        state.existingRecipientsStatus = "idle";
        state.showRefreshPrompt = false;
        state.addTemplate = {
            workFlowStepOBIDs: [],
            userOBIDs: [],
            workFlowTemplateName: "HEX QA Append Reviewer Workflow",
            stepDefName: "SCLBProjComsPerformReview",
            relDefUID: ""
        };
        loadPageContext();
        renderAll();
        updateStatus();
    }
    // Fills in the workflow context directly from the page's own URL, so the
    // tool works the instant a document's Add Recipients or Review page loads -
    // no native search required. The native network hooks (above) still refine
    // stepDefName/relDefUID/addEndpoint automatically when SDx's own automatic
    // calls fire, but that's enrichment now, not a hard requirement.
    function deriveContextFromUrl() {
        if (!isDocumentPage()) return false;
        const ids = getContextObjectOBIDs();
        if (!ids.length) return false;
        state.documentOBID = ids[0];
        if (!state.addTemplate.workFlowStepOBIDs.length) {
            state.addTemplate.workFlowStepOBIDs = ids;
        }
        if (!state.addEndpoint) {
            state.addEndpoint = location.origin + "/ENR01Server/api/v2/SDA/AddRecipients";
        }
        savePageContext();
        return true;
    }
    /************************************************************
     * BMCDLoginUsers Direct API
     ************************************************************/
    function buildBmcdLoginUsersUrl(skip, top, count) {
        const url = new URL(location.origin + "/ENR01Server/api/v2/SDA/BMCDLoginUsers");
        url.searchParams.set("$format", "json");
        url.searchParams.set("$top", String(top));
        url.searchParams.set("$skip", String(skip));
        url.searchParams.set("$count", count ? "true" : "false");
        url.searchParams.set("$orderby", "Name");
        return url.toString();
    }
    async function fetchLoginUsersPage(skip, top, count) {
        const url = buildBmcdLoginUsersUrl(skip, top, count);
        const response = await apiFetch(url, {
            method: "GET",
            headers: getApiHeaders(),
            credentials: "include",
            mode: "cors"
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`BMCDLoginUsers failed: ${response.status} ${response.statusText} ${text}`);
        }
        const data = safeJsonParse(text);
        if (!data) {
            throw new Error("BMCDLoginUsers response was not valid JSON.");
        }
        return data;
    }
    function getODataCount(data) {
        return Number(data?.["@odata.count"] || data?.["odata.count"] || data?.value?.length || 0);
    }
    // Scanning organizations and rebuilding the reviewer database both require
    // paging through the exact same BMCDLoginUsers list, so as of v0.8 they run
    // as a single pass instead of two separate full scans - half the network
    // calls, and only one button to remember.
    function processDatabasePage(users) {
        for (const raw of users || []) {
            const user = normalizeUser(raw);
            if (!user) continue;
            const org = user.Organization || "(Blank Organization)";
            state.orgIndex.set(org, (state.orgIndex.get(org) || 0) + 1);
            if (state.selectedOrgs.has(user.Organization)) {
                state.userCache.set(user.Id, user);
            }
        }
    }
    async function buildDatabase() {
        if (state.dbBusy) return;
        if (!state.selectedOrgs.size) {
            setDatabaseMessage("Select at least one organization before building.", true);
            return;
        }
        state.dbBusy = true;
        setDatabaseBusy(true);
        state.userCache.clear();
        state.orgIndex.clear();
        showProgressBar(true);
        try {
            const selected = Array.from(state.selectedOrgs);
            setDatabaseMessage(`Building reviewer database for project ${state.projectKey}: ${selected.join(", ")}`);
            setProgress(0, 1, "Starting...");
            const first = await fetchLoginUsersPage(0, PAGE_SIZE, true);
            const total = getODataCount(first);
            const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            processDatabasePage(first.value || []);
            setProgress(1, totalPages, `Scanned ${Math.min(PAGE_SIZE, total)} of ${total} users (${state.userCache.size} cached, ${state.orgIndex.size} organizations found)`);
            for (let page = 1; page < totalPages; page++) {
                const skip = page * PAGE_SIZE;
                const data = await fetchLoginUsersPage(skip, PAGE_SIZE, false);
                processDatabasePage(data.value || []);
                setProgress(page + 1, totalPages, `Scanned ${Math.min(skip + PAGE_SIZE, total)} of ${total} users (${state.userCache.size} cached, ${state.orgIndex.size} organizations found)`);
                await sleep(35);
            }
            saveUserCache();
            saveOrgIndex();
            state.orgSelectionDirty = false;
            renderAll();
            setDatabaseMessage(`Database ready for project ${state.projectKey}. Cached ${state.userCache.size} user(s) across ${state.orgIndex.size} known organizations.`);
            setStatus(`Reviewer database ready. Cached ${state.userCache.size} user(s).`);
        } catch (e) {
            err(e);
            if (e instanceof AuthError) {
                setDatabaseMessage(e.message, true);
                setStatus("Session not captured. Click a filter/search in SDx, then try again.", true);
            } else {
                setDatabaseMessage("Database build failed. Try refreshing SDx, then try again.", true);
                setStatus("Database build failed.", true);
            }
        } finally {
            state.dbBusy = false;
            setDatabaseBusy(false);
            showProgressBar(false);
        }
    }
    /************************************************************
     * Existing Recipients (already on this document)
     ************************************************************/
    function buildDocumentReviewDetailsUrl(workflowStepOBID) {
        const url = new URL(location.origin + "/ENR01Server/api/v2/SDA/GetDocumentReviewDetailsByWorkflowStep");
        url.searchParams.set("WorkflowStepOBID", `'${workflowStepOBID}'`);
        url.searchParams.set("ColumnSetUID", "'CS_SCLBQADocReviewColumnSet'");
        url.searchParams.set("CreateTQMethodUID", "'MTH_SCLBCreateDocumentReviewInternalTechnicalQuery'");
        url.searchParams.set("CreateActionMethodUID", "'MTH_SCLBCreateDocumentReviewOutgoingAction'");
        url.searchParams.set("UpdateActionMethodUID", "'MTH_SCLBUpdateAction'");
        url.searchParams.set("EditCommentMethodUID", "'MTH_SDACommentUpdate'");
        url.searchParams.set("LaunchMarkupFromHyperlinkMethod", "'MTH_SCLBFileViewNavigateWithOutgoingAction'");
        url.searchParams.set("LaunchMarkupFromSupportingInformationMethod", "'MTH_SCLBFileViewNavigate'");
        url.searchParams.set("ManageActionMarkupsMethodUID", "'MTH_SCLBManageActionMarkupLayers'");
        url.searchParams.set("ManageActionMarkupsMethodViewOnlyUID", "'MTH_SCLBManageActionMarkupLayersReadOnly'");
        url.searchParams.set("ManageDocumentMarkupsMethodUID", "'MTH_SCLBManageDocMarkupLayersReadOnly'");
        url.searchParams.set("ManageActionRelatedItemsMethodUID", "'MTH_SDAActionRelationshipBuilder'");
        url.searchParams.set("ManageReviewOrCommentRelatedItemsMethodUID", "'MTH_SDAObservationRelationshipBuilder'");
        url.searchParams.set("ReviewMode", "Intergraph.SPF.Server.API.ClientSupport.Types.QualityAssurance.DocumentReview.ReviewMode'1'");
        url.searchParams.set("ActionRejectStatusParam", "'e1XmtlIssueStateDRAFTREJECTED'");
        return url.toString();
    }
    async function fetchDocumentReviewDetails(workflowStepOBID) {
        const url = buildDocumentReviewDetailsUrl(workflowStepOBID);
        const response = await apiFetch(url, {
            method: "GET",
            headers: getApiHeaders(),
            credentials: "include",
            mode: "cors"
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`GetDocumentReviewDetailsByWorkflowStep failed: ${response.status} ${response.statusText} ${text}`);
        }
        // This endpoint wraps its real payload as an OData Edm.String, so the body
        // is JSON containing a JSON *string* that needs a second parse.
        const outer = safeJsonParse(text);
        if (!outer || typeof outer.value !== "string") {
            throw new Error("Unexpected response shape from GetDocumentReviewDetailsByWorkflowStep.");
        }
        const inner = safeJsonParse(outer.value);
        if (!inner) {
            throw new Error("Could not parse document review details payload.");
        }
        return inner;
    }
    async function loadExistingRecipients() {
        if (state.batch.active) return loadBatchExisting(true);
        if (!state.documentOBID) return;
        state.existingRecipientsStatus = "loading";
        renderExistingRecipients();
        try {
            const details = await fetchDocumentReviewDetails(state.documentOBID);
            const combined = [...(details.Users || []), ...(details.RecipientsWithNoReviews || [])];
            state.existingRecipients.clear();
            for (const u of combined) {
                if (u && u.OBID) state.existingRecipients.set(u.OBID, u);
            }
            state.existingRecipientsStatus = "ready";
            log(`Loaded ${state.existingRecipients.size} existing recipient(s) for this document.`);
        } catch (e) {
            warn("Failed to load existing recipients:", e);
            state.existingRecipientsStatus = e instanceof AuthError ? "auth" : "error";
        }
        renderExistingRecipients();
        renderResults();
        renderQueue();
        renderFavorites();
        renderRecents();
    }
    /************************************************************
     * Search and Add
     ************************************************************/
    // Small dependency-free typo tolerance: exact substring matches are always
    // preferred (and free/zero-penalty), but a term that doesn't match anywhere
    // literally still gets a chance against each candidate's name tokens using
    // edit distance, so common misspellings and transpositions ("Jonhson",
    // "Hollenback") still surface - just ranked below exact matches.
    function levenshteinDistance(a, b) {
        if (a === b) return 0;
        const al = a.length;
        const bl = b.length;
        if (al === 0) return bl;
        if (bl === 0) return al;
        let prev = new Array(bl + 1);
        let curr = new Array(bl + 1);
        for (let j = 0; j <= bl; j++) prev[j] = j;
        for (let i = 1; i <= al; i++) {
            curr[0] = i;
            for (let j = 1; j <= bl; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                curr[j] = Math.min(
                    prev[j] + 1,
                    curr[j - 1] + 1,
                    prev[j - 1] + cost
                );
            }
            [prev, curr] = [curr, prev];
        }
        return prev[bl];
    }
    function bestFuzzyScoreForTerm(term, tokens) {
        let best = Infinity;
        for (const token of tokens) {
            if (!token) continue;
            const dist = levenshteinDistance(term, token);
            const norm = dist / Math.max(term.length, token.length, 1);
            if (norm < best) best = norm;
        }
        return best;
    }
    function searchCachedUsers(query) {
        const q = normalize(query);
        if (q.length < 2) {
            state.searchResults = [];
            renderResults();
            setStatus("Type at least 2 characters.");
            return;
        }
        const terms = q.split(/\s+/).filter(Boolean);
        const scored = [];
        for (const user of state.userCache.values()) {
            const haystack = normalize([
                getUserName(user),
                getUserLogin(user),
                getUserEmail(user),
                getUserOrg(user),
                getUserRoles(user),
                getUserId(user)
            ].join(" "));
            const nameTokens = normalize(getUserName(user)).split(/[\s,]+/).filter(Boolean);
            let matchesAllTerms = true;
            let fuzzyPenalty = 0;
            for (const term of terms) {
                if (haystack.includes(term)) continue;
                const score = bestFuzzyScoreForTerm(term, nameTokens);
                const threshold = term.length <= 3 ? 0.3 : 0.4;
                if (score <= threshold) {
                    fuzzyPenalty += score;
                } else {
                    matchesAllTerms = false;
                    break;
                }
            }
            if (matchesAllTerms) {
                scored.push({ user, penalty: fuzzyPenalty });
            }
        }
        scored.sort((a, b) => a.penalty - b.penalty || getUserName(a.user).localeCompare(getUserName(b.user)));
        state.searchResults = scored.slice(0, 100).map(s => s.user);
        renderResults();
        if (state.searchResults.length) {
            const anyFuzzy = scored.slice(0, state.searchResults.length).some(s => s.penalty > 0);
            setStatus(`Showing ${state.searchResults.length} cached result(s).${anyFuzzy ? " Some are close-spelling matches." : ""}`);
        } else {
            setStatus("No cached matches, even allowing for typos. Go to User Database and rebuild with the needed organization selected.", true);
        }
    }
    function queueUser(id) {
        const user = state.userCache.get(id) || resolveUserById(id);
        if (!user) return;
        if (state.existingRecipients.has(id)) {
            setStatus(state.batch.active
                ? `${getUserName(user)} is already on every included document.`
                : `${getUserName(user)} is already a recipient on this document.`, true);
            return;
        }
        if (state.addedThisPage.has(id)) {
            setStatus(`${getUserName(user)} was already added through this tool on this page.`, true);
            return;
        }
        state.queued.set(id, user);
        renderAll();
        setStatus(`Queued ${getUserName(user)}.`);
    }
    function removeQueued(id) {
        state.queued.delete(id);
        renderAll();
    }
    function clearQueue() {
        state.queued.clear();
        renderAll();
        setStatus("Queue cleared.");
    }
    // Sequential one-at-a-time fallback (the original, proven approach). Kept as
    // a safety net in case a batched AddRecipients call is ever rejected by SDx.
    async function addSequentially(users, successes, failures) {
        let stoppedForAuth = false;
        for (let i = 0; i < users.length; i++) {
            const user = users[i];
            setStatus(`Adding ${i + 1} of ${users.length}: ${getUserName(user)}`);
            try {
                await addSingleReviewer(user);
                successes.push(user);
                state.addedThisPage.set(user.Id, user);
                state.queued.delete(user.Id);
                saveRecent(user);
                renderAll();
                await sleep(75);
            } catch (e) {
                failures.push({ user, error: e });
                err(e);
                if (e instanceof AuthError) {
                    stoppedForAuth = true;
                    break;
                }
                await sleep(75);
            }
        }
        return stoppedForAuth;
    }
    async function addQueuedReviewers() {
        if (state.busy) return;
        if (state.batch.active) return addQueuedReviewersBatch();
        const users = Array.from(state.queued.values());
        if (!users.length) {
            setStatus("No reviewers queued.", true);
            return;
        }
        if (!state.addEndpoint || !state.addTemplate.workFlowStepOBIDs.length) {
            setStatus("Missing Add Recipients context for this document. Try reopening the tool on this page.", true);
            return;
        }
        state.busy = true;
        setReviewerBusy(true);
        const successes = [];
        const failures = [];
        let stoppedForAuth = false;
        try {
            if (users.length > 1) {
                // AddRecipients already accepts an array of userOBIDs, so try
                // everyone in ONE request first - far fewer round trips than the
                // old one-request-per-person loop. If SDx rejects the batch for
                // any reason, fall back to the proven sequential method below so
                // nothing is lost, just slower.
                setStatus(`Adding all ${users.length} reviewers in a single request...`);
                try {
                    await addBatchReviewers(users);
                    for (const user of users) {
                        successes.push(user);
                        state.addedThisPage.set(user.Id, user);
                        saveRecent(user);
                    }
                    state.queued.clear();
                    renderAll();
                } catch (e) {
                    err(e);
                    if (e instanceof AuthError) {
                        stoppedForAuth = true;
                        failures.push(...users.map(user => ({ user, error: e })));
                    } else {
                        setStatus("Bulk add wasn't accepted by SDx - adding one at a time instead...", true);
                        stoppedForAuth = await addSequentially(users, successes, failures);
                    }
                }
            } else {
                stoppedForAuth = await addSequentially(users, successes, failures);
            }
            if (stoppedForAuth) {
                setStatus(`Stopped: SDx session expired. Added ${successes.length} before that. Click a filter/search in SDx, then retry the rest.`, true);
            } else if (successes.length && !failures.length) {
                setStatus(`Done. Added ${successes.length} reviewer(s). Double-check "Already On This Document" to confirm everyone landed.`);
            } else if (successes.length && failures.length) {
                setStatus(`Partial success. Added ${successes.length}, failed ${failures.length}. See console.`, true);
            } else {
                setStatus(`No reviewers added. ${failures.length} failed. See console.`, true);
            }
            if (successes.length) {
                state.showRefreshPrompt = true;
                loadExistingRecipients();
            }
        } finally {
            state.busy = false;
            setReviewerBusy(false);
            renderAll();
        }
    }
    function buildAddRecipientsPayload(userOBIDs, stepOBIDs) {
        return {
            workFlowStepOBIDs: stepOBIDs || state.addTemplate.workFlowStepOBIDs,
            userOBIDs,
            workFlowTemplateName: state.addTemplate.workFlowTemplateName || "HEX QA Append Reviewer Workflow",
            stepDefName: state.addTemplate.stepDefName || "SCLBProjComsPerformReview",
            relDefUID: state.addTemplate.relDefUID || ""
        };
    }
    async function addSingleReviewer(user) {
        const payload = buildAddRecipientsPayload([getUserId(user)]);
        const response = await apiFetch(state.addEndpoint, {
            method: "POST",
            headers: getApiHeaders(),
            credentials: "include",
            mode: "cors",
            body: JSON.stringify(payload)
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`${getUserName(user)} failed: ${response.status} ${response.statusText} ${text}`);
        }
        return true;
    }
    async function addBatchReviewers(users) {
        const payload = buildAddRecipientsPayload(users.map(getUserId));
        const response = await apiFetch(state.addEndpoint, {
            method: "POST",
            headers: getApiHeaders(),
            credentials: "include",
            mode: "cors",
            body: JSON.stringify(payload)
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Batch add of ${users.length} reviewer(s) failed: ${response.status} ${response.statusText} ${text}`);
        }
        return true;
    }
    /************************************************************
     * Batch mode (To Do List): add the same reviewers to many documents
     ************************************************************/
    // Confirmed from a live To Do row: each row is an SPFWorkflowStep whose OBID
    // is exactly the ContextObjectOBIDs value of that row's native Add Recipient
    // URL, i.e. the workFlowStepOBIDs AddRecipients expects. The project comes
    // from the row's DynWorkflowItemConfig (the row's own Config is null).
    function isTodoListPage() {
        return /todo-list/i.test(location.hash) || /todo-list/i.test(location.href);
    }
    function getCheckedTodoBoxes() {
        return Array.from(document.querySelectorAll(TODO_CHECKBOX_SELECTOR)).filter(cb => cb.checked && !cb.disabled);
    }
    function collectTodoSelection() {
        const docs = [];
        const seen = new Set();
        const jq = window.jQuery || window.$;
        if (!jq) return docs;
        for (const cb of getCheckedTodoBoxes()) {
            const gridEl = cb.closest(".k-grid");
            if (!gridEl) continue;
            const widget = jq(gridEl).data("kendoGrid");
            if (!widget || typeof widget.dataItem !== "function") continue;
            const row = cb.closest('tr, [role="row"], [role="none"]');
            if (!row) continue;
            let item = null;
            try { item = widget.dataItem(row); } catch {}
            if (!item) {
                const uid = row.getAttribute("data-uid");
                const twin = uid ? gridEl.querySelector(`[data-uid="${uid}"][role="row"]`) : null;
                if (twin) {
                    try { item = widget.dataItem(twin); } catch {}
                }
            }
            if (!item || !item.OBID) continue;
            if (item.Class && item.Class !== "SPFWorkflowStep") continue;
            if (seen.has(item.OBID)) continue;
            seen.add(item.OBID);
            docs.push({
                id: item.OBID,
                name: String(item.CI_WorkflowItem || item.DynWorkflowItemName || item.OBID).trim(),
                desc: String(item.CI_bmcdWorkflowItemDesc || "").trim(),
                step: String(item.Name || item.CI_Name || "").trim(),
                reason: String(item.CI_ReasonForReceipt || "").trim(),
                workflow: String(item.CI_WorkflowName || "").trim(),
                project: String(item.DynWorkflowItemConfig || item.Config || "").trim()
            });
        }
        return docs;
    }
    // AddRecipients is the Consolidation step's "Add Reviewer" action, so rows
    // for any other step start unchecked in the batch window (user can opt in).
    function isConsolidationDoc(doc) {
        return /consolidation/i.test(`${doc.reason} ${doc.step}`);
    }
    function refreshBatchSelection(force) {
        const n = getCheckedTodoBoxes().length;
        if (!force && n === state.batch.lastChecked) return;
        state.batch.lastChecked = n;
        state.batch.selection = n ? collectTodoSelection() : [];
    }
    function removeBatchButton() {
        document.getElementById(BATCH_BTN_ID)?.remove();
    }
    function findBatchAnchor() {
        for (const id of ["sdx-qol-dl-files-btn", "sdx-qol-manager-button"]) {
            const el = document.getElementById(id);
            if (el && el.isConnected) return { el, append: false };
        }
        const exportEl = Array.from(document.querySelectorAll("button, a, span"))
            .find(el => /^export all to excel$/i.test(String(el.textContent || "").replace(/\s+/g, " ").trim()));
        if (exportEl) return { el: exportEl.closest("button, a") || exportEl, append: false };
        const toolbar = document.querySelector('[role="toolbar"], .toolbar, .command-bar, .mat-toolbar, .k-toolbar');
        return toolbar ? { el: toolbar, append: true } : null;
    }
    function ensureBatchButton() {
        if (!isTodoListPage()) {
            removeBatchButton();
            state.batch.lastChecked = -1;
            return;
        }
        if (state.batch.active && isModalOpen()) return;
        refreshBatchSelection(false);
        const count = state.batch.selection.length;
        let btn = document.getElementById(BATCH_BTN_ID);
        if (count < 1) {
            btn?.remove();
            return;
        }
        if (!btn || !btn.isConnected) {
            const anchor = findBatchAnchor();
            if (!anchor) return;
            btn = document.createElement("button");
            btn.id = BATCH_BTN_ID;
            btn.type = "button";
            btn.className = "sdxbr-batch-btn";
            btn.addEventListener("click", e => {
                e.preventDefault();
                e.stopPropagation();
                openBatchModal();
            }, true);
            if (anchor.append) anchor.el.appendChild(btn);
            else anchor.el.insertAdjacentElement("afterend", btn);
        }
        btn.textContent = count === 1
            ? `${WIZARD_ICON} Add reviewers`
            : `${WIZARD_ICON} Batch add reviewers (${count})`;
        btn.title = count === 1
            ? "Add reviewers to the selected document"
            : "Add the same reviewers to every selected document";
    }
    function includedBatchDocs() {
        return state.batch.docs.filter(d => d.include);
    }
    function applyBatchContext() {
        const ids = includedBatchDocs().map(d => d.id);
        state.addTemplate.workFlowStepOBIDs = ids;
        state.documentOBID = ids[0] || null;
        state.addEndpoint = location.origin + "/ENR01Server/api/v2/SDA/AddRecipients";
        const saved = readJson(storeKey(STORE.lastAddTemplatePrefix), null);
        if (saved) {
            for (const key of ["workFlowTemplateName", "stepDefName", "relDefUID"]) {
                if (saved[key]) state.addTemplate[key] = saved[key];
            }
        }
    }
    function openBatchModal() {
        refreshBatchSelection(true);
        const selection = state.batch.selection;
        if (!selection.length) {
            alert("Reviewer Wizard: couldn't read any selected rows. Re-select the documents and try again.");
            return;
        }
        const projects = Array.from(new Set(selection.map(d => d.project)));
        if (projects.length !== 1 || !projects[0]) {
            alert(
                projects.length > 1
                    ? `Reviewer Wizard: your selection spans more than one project (${projects.filter(Boolean).join(", ")}). Reviewer lists are kept per project, so select documents from one project at a time.`
                    : "Reviewer Wizard: couldn't determine the project for the selected documents."
            );
            return;
        }
        state.batch.active = true;
        state.batch.docs = selection.map(d => ({ ...d, include: isConsolidationDoc(d) }));
        state.batch.existing = new Map();
        state.batch.results = null;
        state.projectKey = projects[0];
        loadProjectScopedState();
        loadAuthHeaders();
        resetPerDocumentPage();
        applyBatchContext();
        installModal();
        document.getElementById(IDS.backdrop)?.classList.add("open");
        document.getElementById(IDS.modal)?.classList.add("open");
        switchTab("reviewers");
        updateStatus();
        updateSessionIndicator();
        loadBatchExisting(false);
    }
    async function loadBatchDocExisting(doc, map) {
        const entry = { status: "loading", users: new Map() };
        map.set(doc.id, entry);
        try {
            const details = await fetchDocumentReviewDetails(doc.id);
            for (const u of [...(details.Users || []), ...(details.RecipientsWithNoReviews || [])]) {
                if (u && u.OBID) entry.users.set(u.OBID, u);
            }
            entry.status = "ready";
        } catch (e) {
            warn(`Failed to load reviewers for ${doc.name}:`, e);
            entry.status = e instanceof AuthError ? "auth" : "error";
            entry.error = e;
        }
    }
    // Fetches each included document's current reviewers (4 at a time). With
    // force=false only documents not already loaded are fetched.
    async function loadBatchExisting(force) {
        if (!state.batch.active) return;
        const map = state.batch.existing;
        const docs = includedBatchDocs().filter(d => force || map.get(d.id)?.status !== "ready");
        if (!docs.length) {
            recomputeBatchExisting();
            renderBatchDependents();
            return;
        }
        docs.forEach(d => map.set(d.id, { status: "loading", users: new Map() }));
        recomputeBatchExisting();
        renderExistingRecipients();
        let next = 0;
        const worker = async () => {
            while (next < docs.length) {
                const doc = docs[next++];
                await loadBatchDocExisting(doc, map);
                if (!state.batch.active || state.batch.existing !== map) return;
                recomputeBatchExisting();
                renderExistingRecipients();
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, docs.length) }, worker));
        if (!state.batch.active || state.batch.existing !== map) return;
        recomputeBatchExisting();
        renderBatchDependents();
    }
    // state.existingRecipients doubles as "on EVERY included document" in batch
    // mode, so the existing Queue/Search/Favorites "On Document" logic just works.
    function recomputeBatchExisting() {
        if (!state.batch.active) return;
        const included = includedBatchDocs();
        const entries = included.map(d => state.batch.existing.get(d.id));
        state.existingRecipients = new Map();
        const anyLoading = entries.some(e => !e || e.status === "loading");
        const anyAuth = entries.some(e => e && e.status === "auth");
        const anyError = entries.some(e => e && e.status === "error");
        if (!included.length) state.existingRecipientsStatus = "idle";
        else if (anyLoading) state.existingRecipientsStatus = "loading";
        else if (anyAuth) state.existingRecipientsStatus = "auth";
        else if (anyError) state.existingRecipientsStatus = "error";
        else state.existingRecipientsStatus = "ready";
        if (state.existingRecipientsStatus === "ready") {
            for (const [id, user] of entries[0].users) {
                if (entries.every(e => e.users.has(id))) state.existingRecipients.set(id, user);
            }
        }
    }
    // People already on SOME (not all) included documents, with which documents.
    function getBatchPartialRecipients() {
        const included = includedBatchDocs();
        const counts = new Map();
        for (const doc of included) {
            const entry = state.batch.existing.get(doc.id);
            if (!entry || entry.status !== "ready") continue;
            for (const [id, user] of entry.users) {
                if (!counts.has(id)) counts.set(id, { user, docs: [] });
                counts.get(id).docs.push(doc);
            }
        }
        return Array.from(counts.values())
            .filter(c => c.docs.length < included.length)
            .sort((a, b) => String(a.user.DisplayName || "").localeCompare(String(b.user.DisplayName || "")));
    }
    function renderBatchDependents() {
        updateModalHeader();
        renderExistingRecipients();
        renderResults();
        renderQueue();
        renderFavorites();
        renderRecents();
    }
    async function postAddRecipients(stepIds, userIds) {
        const payload = buildAddRecipientsPayload(userIds, stepIds);
        const response = await apiFetch(state.addEndpoint, {
            method: "POST",
            headers: getApiHeaders(),
            credentials: "include",
            mode: "cors",
            body: JSON.stringify(payload)
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`AddRecipients failed for ${stepIds.length} document(s): ${response.status} ${response.statusText} ${text}`);
        }
        return true;
    }
    // Fallback used when a multi-document request is rejected. Re-reads what is
    // on the document first, in case the earlier request partly applied, so
    // nobody is added twice. Returns true if the session expired.
    async function addToSingleBatchDoc(doc, users, result) {
        await loadBatchDocExisting(doc, state.batch.existing);
        const entry = state.batch.existing.get(doc.id);
        if (!entry || entry.status !== "ready") {
            const error = entry?.error || new Error("Could not re-check current reviewers");
            result.failed.push(...users.map(user => ({ user, error })));
            return error instanceof AuthError;
        }
        result.added.push(...users.filter(u => entry.users.has(u.Id)));
        const need = users.filter(u => !entry.users.has(u.Id));
        if (!need.length) return false;
        try {
            await postAddRecipients([doc.id], need.map(getUserId));
            result.added.push(...need);
            return false;
        } catch (e) {
            err(e);
            if (e instanceof AuthError) {
                result.failed.push(...need.map(user => ({ user, error: e })));
                return true;
            }
        }
        for (const user of need) {
            try {
                await postAddRecipients([doc.id], [getUserId(user)]);
                result.added.push(user);
            } catch (e) {
                err(e);
                result.failed.push({ user, error: e });
                if (e instanceof AuthError) return true;
            }
            await sleep(75);
        }
        return false;
    }
    async function addQueuedReviewersBatch() {
        const users = Array.from(state.queued.values());
        if (!users.length) {
            setStatus("No reviewers queued.", true);
            return;
        }
        const docs = includedBatchDocs();
        if (!docs.length) {
            setStatus("No documents are included. Tick at least one document above.", true);
            return;
        }
        state.busy = true;
        setReviewerBusy(true);
        const map = state.batch.existing;
        const results = new Map(docs.map(d => [d.id, { doc: d, added: [], skipped: [], failed: [] }]));
        let stoppedForAuth = false;
        try {
            // Always start from a fresh snapshot so nobody is added twice.
            setStatus(`Checking current reviewers on ${docs.length} document(s)...`);
            await loadBatchExisting(true);
            const plan = [];
            for (const doc of docs) {
                const result = results.get(doc.id);
                const entry = map.get(doc.id);
                if (!entry || entry.status !== "ready") {
                    const error = entry?.error || new Error("Could not read current reviewers for this document");
                    result.failed.push(...users.map(user => ({ user, error })));
                    if (error instanceof AuthError) stoppedForAuth = true;
                    continue;
                }
                result.skipped = users.filter(u => entry.users.has(u.Id));
                const need = users.filter(u => !entry.users.has(u.Id));
                if (need.length) plan.push({ doc, users: need });
            }
            // Documents needing the exact same people share one request.
            const groups = new Map();
            for (const p of plan) {
                const key = p.users.map(u => u.Id).sort().join("|");
                if (!groups.has(key)) groups.set(key, { users: p.users, docs: [] });
                groups.get(key).docs.push(p.doc);
            }
            let groupNo = 0;
            for (const group of groups.values()) {
                if (stoppedForAuth) break;
                groupNo++;
                setStatus(`Adding ${group.users.length} reviewer(s) to ${group.docs.length} document(s) (request ${groupNo} of ${groups.size})...`);
                try {
                    await postAddRecipients(group.docs.map(d => d.id), group.users.map(getUserId));
                    for (const doc of group.docs) results.get(doc.id).added.push(...group.users);
                } catch (e) {
                    err(e);
                    if (e instanceof AuthError) {
                        stoppedForAuth = true;
                        for (const doc of group.docs) results.get(doc.id).failed.push(...group.users.map(user => ({ user, error: e })));
                        break;
                    }
                    setStatus("SDx didn't accept the multi-document request - adding one document at a time...", true);
                    for (const doc of group.docs) {
                        if (stoppedForAuth) break;
                        stoppedForAuth = await addToSingleBatchDoc(doc, group.users, results.get(doc.id));
                    }
                }
                await sleep(75);
            }
            // Anything never attempted (session expired mid-run) counts as failed.
            const authError = new AuthError("Not attempted - session expired.");
            for (const p of plan) {
                const r = results.get(p.doc.id);
                if (!r.added.length && !r.failed.length) r.failed.push(...p.users.map(user => ({ user, error: authError })));
            }
            state.batch.results = Array.from(results.values());
            const failedIds = new Set();
            let addedCount = 0;
            for (const r of state.batch.results) {
                addedCount += r.added.length;
                r.failed.forEach(f => failedIds.add(f.user.Id));
            }
            for (const user of users) {
                if (!failedIds.has(user.Id)) {
                    state.queued.delete(user.Id);
                    state.addedThisPage.set(user.Id, user);
                }
                if (state.batch.results.some(r => r.added.some(a => a.Id === user.Id))) saveRecent(user);
            }
            const failedDocs = state.batch.results.filter(r => r.failed.length).length;
            if (stoppedForAuth) {
                setStatus(`Stopped: SDx session expired. Click a filter/search in SDx, then press Add again to finish the rest.`, true);
            } else if (!failedDocs) {
                setStatus(`Done. ${addedCount} reviewer assignment(s) added across ${docs.length} document(s).`);
            } else {
                setStatus(`Partial: ${failedDocs} of ${docs.length} document(s) had failures. Fix and press Add again - already-added reviewers are skipped.`, true);
            }
            if (addedCount) state.showRefreshPrompt = true;
        } finally {
            state.busy = false;
            setReviewerBusy(false);
            renderAll();
        }
        if (state.batch.active) loadBatchExisting(true);
    }
    function renderBatchPanel(container, statusEl) {
        const docs = state.batch.docs;
        const included = includedBatchDocs();
        const statusText = {
            idle: "Nothing included.",
            loading: "Loading current reviewers...",
            auth: "Session expired - click a filter in SDx, then Refresh.",
            error: "Couldn't load reviewers for some documents. Click Refresh.",
            ready: "Reviewers loaded."
        }[state.existingRecipientsStatus] || "";
        if (statusEl) statusEl.textContent = `${included.length} of ${docs.length} included. ${statusText}`;
        const chip = u => `<span class="sdxbr-chip" title="OBID: ${escapeHtml(u.OBID)}">${escapeHtml(u.DisplayName || u.OBID)}</span>`;
        const everyone = Array.from(state.existingRecipients.values())
            .sort((a, b) => String(a.DisplayName || "").localeCompare(String(b.DisplayName || "")));
        const ready = state.existingRecipientsStatus === "ready";
        const partial = ready ? getBatchPartialRecipients() : [];
        const skippedNote = docs.some(d => !isConsolidationDoc(d))
            ? `<div class="sdxbr-muted" style="margin-bottom:6px;">Rows that aren't a Consolidation step start unchecked, since Add Reviewer is a Consolidation action. Tick them to include anyway.</div>`
            : "";
        const docRows = docs.map(d => {
            const entry = state.batch.existing.get(d.id);
            const names = entry && entry.status === "ready"
                ? Array.from(entry.users.values()).map(u => u.DisplayName || u.OBID).sort().join(", ")
                : "";
            const count = !d.include ? "not included"
                : !entry || entry.status === "loading" ? "loading..."
                : entry.status === "ready" ? `${entry.users.size} reviewer${entry.users.size === 1 ? "" : "s"}`
                : "couldn't load";
            return `
                <label class="sdxbr-batch-doc" title="${escapeHtml([d.name, d.desc, d.step, d.workflow].filter(Boolean).join(" | "))}">
                    <input type="checkbox" class="sdxbr-batch-include" data-id="${escapeHtml(d.id)}" ${d.include ? "checked" : ""}>
                    <span class="sdxbr-batch-doc-name">${escapeHtml(d.name)}</span>
                    <span class="sdxbr-batch-doc-meta">${escapeHtml([d.desc, d.step].filter(Boolean).join(" - "))}</span>
                    <span class="sdxbr-pill" title="${escapeHtml(names)}">${escapeHtml(count)}</span>
                </label>`;
        }).join("");
        const resultsHtml = state.batch.results ? `
            <div class="sdxbr-batch-section-title" style="margin-top:10px;">Last run</div>
            ${state.batch.results.map(r => {
                const lines = [];
                if (r.added.length) lines.push(`<div class="sdxbr-batch-ok">Added: ${escapeHtml(r.added.map(getUserName).join(", "))}</div>`);
                if (r.skipped.length) lines.push(`<div class="sdxbr-muted">Already had: ${escapeHtml(r.skipped.map(getUserName).join(", "))}</div>`);
                if (r.failed.length) {
                    const reason = String(r.failed[0].error && r.failed[0].error.message || "unknown error").slice(0, 140);
                    lines.push(`<div class="sdxbr-batch-fail">Failed: ${escapeHtml(r.failed.map(f => getUserName(f.user)).join(", "))} - ${escapeHtml(reason)}</div>`);
                }
                if (!lines.length) lines.push(`<div class="sdxbr-muted">Nothing to do.</div>`);
                return `<div class="sdxbr-batch-result"><strong>${escapeHtml(r.doc.name)}</strong>${lines.join("")}</div>`;
            }).join("")}
            ${state.batch.results.some(r => r.failed.length) && state.queued.size ? `<button type="button" class="sdxbr-btn sdxbr-primary" id="sdxbrBatchRetry" style="margin-top:6px;">Retry failed</button>` : ""}
        ` : "";
        const sharedHtml = everyone.length
            ? everyone.map(chip).join("")
            : `<span class="sdxbr-muted">${ready ? "No one is on every included document." : "Loading..."}</span>`;
        const partialHtml = partial.length
            ? partial.map(c => `<span class="sdxbr-chip sdxbr-chip-partial" title="${escapeHtml(c.docs.map(d => d.name).join(", "))}">${escapeHtml(c.user.DisplayName || c.user.OBID)} (${c.docs.length}/${included.length})</span>`).join("")
            : `<span class="sdxbr-muted">${ready ? "No one is on only some of the documents." : "Loading..."}</span>`;
        container.innerHTML = `
            ${skippedNote}
            <div class="sdxbr-batch-grid">
                <div class="sdxbr-batch-col">
                    <div class="sdxbr-batch-col-title">
                        <span>Documents (${included.length}/${docs.length})</span>
                        <span class="sdxbr-batch-col-actions">
                            <button type="button" class="sdxbr-mini-btn" id="sdxbrBatchAll">All</button>
                            <button type="button" class="sdxbr-mini-btn" id="sdxbrBatchNone">None</button>
                        </span>
                    </div>
                    <div class="sdxbr-batch-col-body">${docRows}</div>
                </div>
                <div class="sdxbr-batch-col">
                    <div class="sdxbr-batch-col-title"><span>Shared - on every document</span><span class="sdxbr-pill">${everyone.length}</span></div>
                    <div class="sdxbr-batch-col-body">${sharedHtml}</div>
                </div>
                <div class="sdxbr-batch-col">
                    <div class="sdxbr-batch-col-title"><span>Unique - only some documents</span><span class="sdxbr-pill">${partial.length}</span></div>
                    <div class="sdxbr-batch-col-body">${partialHtml}</div>
                </div>
            </div>
            ${resultsHtml}
        `;
        container.querySelectorAll(".sdxbr-batch-include").forEach(cb => {
            cb.addEventListener("change", () => {
                const doc = state.batch.docs.find(d => d.id === cb.dataset.id);
                if (!doc) return;
                doc.include = cb.checked;
                applyBatchContext();
                recomputeBatchExisting();
                renderBatchDependents();
                if (cb.checked) loadBatchExisting(false);
            });
        });
        const setAll = value => {
            state.batch.docs.forEach(d => { d.include = value; });
            applyBatchContext();
            recomputeBatchExisting();
            renderBatchDependents();
            if (value) loadBatchExisting(false);
        };
        document.getElementById("sdxbrBatchAll")?.addEventListener("click", () => setAll(true));
        document.getElementById("sdxbrBatchNone")?.addEventListener("click", () => setAll(false));
        document.getElementById("sdxbrBatchRetry")?.addEventListener("click", () => addQueuedReviewers());
    }
    function updateModalHeader() {
        const titleEl = document.getElementById("sdxbrTitle");
        const subtitleEl = document.getElementById("sdxbrSubtitle");
        if (titleEl && subtitleEl) {
            if (state.batch.active) {
                titleEl.textContent = `${WIZARD_ICON} ${TOOL_NAME} - Batch`;
                subtitleEl.textContent = `v${VERSION} | Adding to ${includedBatchDocs().length} of ${state.batch.docs.length} selected documents | Project ${state.projectKey}`;
            } else {
                titleEl.textContent = `${WIZARD_ICON} ${TOOL_NAME}`;
                subtitleEl.textContent = `v${VERSION} | Per-project database | Favorites | Zero-click context`;
            }
        }
        const addBtn = document.getElementById("sdxbrAddReviewers");
        if (addBtn) {
            addBtn.textContent = state.batch.active
                ? `Add to ${includedBatchDocs().length} document${includedBatchDocs().length === 1 ? "" : "s"}`
                : "Add Reviewers";
        }
    }
    /************************************************************
     * UI
     ************************************************************/
    function installStyles() {
        if (document.getElementById(IDS.style)) return;
        const style = document.createElement("style");
        style.id = IDS.style;
        style.textContent = `
            .sdxbr-docked {
                height: 30px;
                padding: 0 13px;
                margin-left: 10px;
                border-radius: 15px;
                border: 1px solid #0f6cbd;
                background: linear-gradient(180deg, #0f6cbd, #075a9c);
                color: #fff;
                font-family: "Segoe UI", Arial, sans-serif;
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 0.2px;
                cursor: pointer;
                vertical-align: middle;
                white-space: nowrap;
            }
            .sdxbr-docked:hover {
                background: linear-gradient(180deg, #1683df, #0f6cbd);
            }
            #${IDS.backdrop} {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.18);
                z-index: 999998;
                display: none;
            }
            #${IDS.modal} {
                position: fixed;
                top: 72px;
                right: 30px;
                width: 1120px;
                max-width: calc(100vw - 60px);
                max-height: calc(100vh - 110px);
                z-index: 999999;
                background: #fff;
                color: #242424;
                border-radius: 10px;
                border: 1px solid #c8d1dc;
                box-shadow: 0 14px 40px rgba(0,0,0,0.28);
                font-family: "Segoe UI", Arial, sans-serif;
                overflow: hidden;
                display: none;
            }
            #${IDS.backdrop}.open,
            #${IDS.modal}.open {
                display: block;
            }
            #${IDS.modal} .sdxbr-header {
                background: #005a9e;
                color: #fff;
                padding: 12px 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #${IDS.modal} .sdxbr-title {
                font-size: 15px;
                font-weight: 700;
            }
            #${IDS.modal} .sdxbr-subtitle {
                font-size: 11px;
                opacity: 0.85;
                margin-top: 2px;
            }
            #${IDS.modal} .sdxbr-header-right {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            #${IDS.modal} .sdxbr-session-pill {
                font-size: 11px;
                font-weight: 700;
                padding: 4px 9px;
                border-radius: 999px;
                white-space: nowrap;
            }
            #${IDS.modal} .sdxbr-session-pill.ok {
                background: #dff6dd;
                color: #0e5c1f;
            }
            #${IDS.modal} .sdxbr-session-pill.missing {
                background: rgba(255,255,255,0.25);
                color: #fff;
            }
            #${IDS.modal} .sdxbr-session-pill.stale {
                background: #fde7e9;
                color: #a4262c;
            }
            #${IDS.modal} .sdxbr-close {
                border: 0;
                background: rgba(255,255,255,0.2);
                color: #fff;
                border-radius: 5px;
                padding: 5px 9px;
                cursor: pointer;
                font-weight: 700;
            }
            #${IDS.modal} .sdxbr-tabs {
                display: flex;
                border-bottom: 1px solid #d7dee7;
                background: #f3f7fb;
            }
            #${IDS.modal} .sdxbr-tab {
                border: 0;
                background: transparent;
                padding: 10px 14px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 700;
                color: #37506b;
                border-bottom: 3px solid transparent;
            }
            #${IDS.modal} .sdxbr-tab.active {
                background: #fff;
                color: #005a9e;
                border-bottom-color: #0078d4;
            }
            #${IDS.modal} .sdxbr-body {
                padding: 12px;
                overflow: auto;
                max-height: calc(100vh - 225px);
            }
            #${IDS.modal} .sdxbr-toolbar {
                display: grid;
                grid-template-columns: 1fr auto auto;
                gap: 8px;
                margin-bottom: 10px;
                align-items: center;
            }
            #${IDS.modal} input[type="text"] {
                height: 34px;
                border: 1px solid #b9c5d0;
                border-radius: 6px;
                padding: 0 10px;
                font-size: 13px;
                outline: none;
                width: 100%;
                box-sizing: border-box;
            }
            #${IDS.modal} input[type="text"]:focus {
                border-color: #0078d4;
                box-shadow: 0 0 0 2px rgba(0,120,212,0.15);
            }
            #${IDS.modal} .sdxbr-grid {
                display: grid;
                grid-template-columns: 1.2fr 0.8fr;
                gap: 12px;
            }
            #${IDS.modal} .sdxbr-grid-3 {
                display: grid;
                grid-template-columns: 0.85fr 1.3fr 0.85fr;
                gap: 12px;
                margin-bottom: 12px;
            }
            #${IDS.modal} .sdxbr-panel {
                border: 1px solid #d7dee7;
                border-radius: 8px;
                overflow: hidden;
                background: #fafafa;
            }
            #${IDS.modal} .sdxbr-panel-title {
                padding: 6px 10px;
                background: #eef4fb;
                border-bottom: 1px solid #d7dee7;
                font-size: 12px;
                font-weight: 700;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
            }
            #${IDS.modal} .sdxbr-panel-body {
                background: #fff;
                min-height: 140px;
                max-height: 300px;
                overflow: auto;
            }
            #${IDS.modal} .sdxbr-existing-body {
                min-height: 0;
                max-height: 150px;
            }
            #${IDS.modal} .sdxbr-workspace {
                display: flex;
                gap: 12px;
                margin-bottom: 12px;
                align-items: stretch;
            }
            #${IDS.modal} .sdxbr-sidebar {
                display: flex;
                flex-direction: column;
                gap: 12px;
                flex: 0 0 260px;
                min-width: 0;
            }
            #${IDS.modal} .sdxbr-favorites-panel {
                display: flex;
                flex-direction: column;
                flex: 1;
            }
            #${IDS.modal} .sdxbr-favorites-panel .sdxbr-panel-body {
                flex: 1;
                min-height: 160px;
                max-height: none;
            }
            #${IDS.modal} .sdxbr-recents-panel .sdxbr-panel-body {
                min-height: 0;
                max-height: 130px;
            }
            #${IDS.modal} .sdxbr-main {
                display: flex;
                flex-direction: column;
                gap: 12px;
                flex: 1;
                min-width: 0;
            }
            #${IDS.modal} .sdxbr-main-row {
                display: flex;
                gap: 12px;
            }
            #${IDS.modal} .sdxbr-main-row > .sdxbr-panel {
                flex: 1;
                min-width: 0;
            }
            #${IDS.modal} .sdxbr-addedpage-panel .sdxbr-panel-body {
                min-height: 0;
                max-height: 70px;
            }
            #${IDS.modal} .sdxbr-user-row {
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 6px;
                padding: 5px 10px;
                border-bottom: 1px solid #edf0f4;
                align-items: center;
            }
            #${IDS.modal} .sdxbr-user-row:last-child {
                border-bottom: 0;
            }
            #${IDS.modal} .sdxbr-user-name {
                font-size: 12px;
                font-weight: 700;
                color: #242424;
                line-height: 1.3;
            }
            #${IDS.modal} .sdxbr-user-meta {
                font-size: 10px;
                color: #666;
                margin-top: 1px;
                word-break: break-word;
                line-height: 1.3;
            }
            #${IDS.modal} .sdxbr-row-actions {
                display: flex;
                gap: 4px;
                align-items: center;
            }
            #${IDS.modal} .sdxbr-btn,
            #${IDS.modal} .sdxbr-mini-btn {
                border: 1px solid #b9c5d0;
                background: #fff;
                color: #242424;
                border-radius: 6px;
                padding: 6px 10px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 700;
                white-space: nowrap;
            }
            #${IDS.modal} .sdxbr-mini-btn {
                color: #005a9e;
                border-color: #9fb8d1;
                padding: 4px 7px;
                font-size: 11px;
            }
            #${IDS.modal} .sdxbr-btn:hover,
            #${IDS.modal} .sdxbr-mini-btn:hover {
                background: #f3f8fd;
            }
            #${IDS.modal} .sdxbr-star-btn {
                color: #a9852c;
                padding: 4px 6px;
            }
            #${IDS.modal} .sdxbr-star-btn.active {
                background: #fff6da;
                border-color: #e8c65a;
                color: #8a6d1d;
            }
            #${IDS.modal} .sdxbr-primary {
                background: #0078d4;
                color: #fff;
                border-color: #0078d4;
            }
            #${IDS.modal} .sdxbr-primary:hover {
                background: #106ebe;
            }
            #${IDS.modal} .sdxbr-danger {
                color: #a4262c;
                border-color: #d7a0a4;
            }
            #${IDS.modal} .sdxbr-footer {
                padding: 10px 12px;
                border-top: 1px solid #d7dee7;
                background: #f7f9fc;
                display: grid;
                grid-template-columns: 1fr auto auto;
                gap: 8px;
                align-items: center;
            }
            #${IDS.modal} .sdxbr-status {
                font-size: 12px;
                color: #333;
                padding: 7px 9px;
                background: #edf5fc;
                border: 1px solid #d2e5f5;
                border-radius: 6px;
            }
            #${IDS.modal} .sdxbr-status.warning {
                background: #fff4ce;
                border-color: #ffb900;
            }
            #${IDS.modal} .sdxbr-muted {
                padding: 10px;
                color: #777;
                font-size: 12px;
            }
            #${IDS.modal} .sdxbr-pill {
                background: #dceeff;
                color: #005a9e;
                border-radius: 999px;
                padding: 2px 7px;
                font-size: 11px;
                font-weight: 700;
            }
            #${IDS.modal} .sdxbr-chip {
                display: inline-block;
                background: #eef4fb;
                border: 1px solid #cddcec;
                border-radius: 999px;
                padding: 3px 9px;
                margin: 3px;
                font-size: 11px;
                color: #2b415a;
            }
            #${IDS.modal} .sdxbr-existing-status {
                font-weight: 400;
                font-size: 11px;
                color: #555;
            }
            #${IDS.modal} .sdxbr-note {
                background: #fff4ce;
                border: 1px solid #ffb900;
                padding: 10px;
                border-radius: 7px;
                font-size: 12px;
                margin-bottom: 10px;
            }
            #${IDS.modal} .sdxbr-refresh-banner {
                background: #dff6dd;
                border: 1px solid #57a64a;
                padding: 8px 10px;
                border-radius: 7px;
                font-size: 12px;
                margin-bottom: 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;
            }
            #${IDS.modal} .sdxbr-db-actions {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
                margin: 10px 0;
                align-items: center;
            }
            #${IDS.modal} .sdxbr-progress-wrap {
                margin: 4px 0 10px 0;
            }
            #${IDS.modal} .sdxbr-progress-bar {
                height: 10px;
                background: #e2e8f0;
                border-radius: 6px;
                overflow: hidden;
            }
            #${IDS.modal} .sdxbr-progress-fill {
                height: 100%;
                width: 0%;
                background: linear-gradient(90deg, #0078d4, #12b866);
                transition: width 0.2s ease;
            }
            #${IDS.modal} .sdxbr-progress-label {
                font-size: 11px;
                color: #444;
                margin-top: 4px;
            }
            #${IDS.modal} .sdxbr-org-list {
                border: 1px solid #d7dee7;
                border-radius: 8px;
                max-height: 330px;
                overflow: auto;
                background: #fff;
            }
            #${IDS.modal} .sdxbr-org-row {
                display: grid;
                grid-template-columns: auto 1fr auto;
                gap: 8px;
                align-items: center;
                padding: 7px 10px;
                border-bottom: 1px solid #edf0f4;
                font-size: 12px;
            }
            #${IDS.modal} .sdxbr-org-row:last-child {
                border-bottom: 0;
            }
            #${IDS.modal} .sdxbr-context-line {
                padding: 6px 10px;
                border-bottom: 1px solid #edf0f4;
                font-size: 12px;
                word-break: break-word;
            }
            #${IDS.modal} .sdxbr-context-label {
                font-weight: 700;
            }
            #${IDS.modal} button:disabled,
            #${IDS.modal} input:disabled {
                opacity: 0.55;
                cursor: not-allowed;
            }
        `;
        document.head.appendChild(style);
    }
    function installBatchStyles() {
        const id = IDS.style + "_batch";
        if (document.getElementById(id)) return;
        const style = document.createElement("style");
        style.id = id;
        style.textContent = `
            .sdxbr-batch-btn {
                height: 30px;
                padding: 0 13px;
                margin-left: 8px;
                border-radius: 15px;
                border: 1px solid #0f6cbd;
                background: linear-gradient(180deg, #0f6cbd, #075a9c);
                color: #fff;
                font-family: "Segoe UI", Arial, sans-serif;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
                vertical-align: middle;
                white-space: nowrap;
            }
            .sdxbr-batch-btn:hover {
                background: linear-gradient(180deg, #1683df, #0f6cbd);
            }
            #${IDS.modal} .sdxbr-batch-section-title {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
                font-weight: 700;
                margin: 4px 0;
            }
            #${IDS.modal} .sdxbr-existing-body.sdxbr-batch-body {
                max-height: none;
                overflow: visible;
                min-height: 0;
            }
            #${IDS.modal} .sdxbr-batch-grid {
                display: grid;
                grid-template-columns: 1.5fr 1fr 1fr;
                gap: 10px;
            }
            #${IDS.modal} .sdxbr-batch-col {
                border: 1px solid #d8dee6;
                border-radius: 6px;
                min-width: 0;
                display: flex;
                flex-direction: column;
            }
            #${IDS.modal} .sdxbr-batch-col-title {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 6px;
                padding: 5px 8px;
                font-size: 12px;
                font-weight: 700;
                background: #f3f6fa;
                border-bottom: 1px solid #d8dee6;
                border-radius: 6px 6px 0 0;
            }
            #${IDS.modal} .sdxbr-batch-col-actions {
                display: flex;
                flex-direction: row;
                flex-wrap: nowrap;
                gap: 6px;
                flex: 0 0 auto;
            }
            #${IDS.modal} .sdxbr-batch-col-actions .sdxbr-mini-btn {
                width: auto;
                height: auto;
                padding: 2px 8px;
                white-space: nowrap;
            }
            #${IDS.modal} .sdxbr-batch-doc .sdxbr-pill {
                flex: 0 0 auto;
                white-space: nowrap;
            }
            #${IDS.modal} .sdxbr-batch-col-body {
                height: 230px;
                overflow: auto;
                padding: 4px 6px;
            }
            #${IDS.modal} .sdxbr-batch-doc {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 3px 0;
                font-size: 12px;
                cursor: pointer;
                border-bottom: 1px solid #f0f2f5;
            }
            #${IDS.modal} .sdxbr-batch-doc:last-child { border-bottom: none; }
            #${IDS.modal} .sdxbr-batch-doc-name { font-weight: 700; white-space: nowrap; }
            #${IDS.modal} .sdxbr-batch-doc-meta {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #666;
            }
            #${IDS.modal} .sdxbr-chip-partial {
                background: #fff8e1;
                border-color: #f0d98a;
            }
            #${IDS.modal} .sdxbr-batch-result {
                font-size: 12px;
                padding: 4px 0;
                border-bottom: 1px solid #f0f2f5;
            }
            #${IDS.modal} .sdxbr-batch-ok { color: #1e6b2a; }
            #${IDS.modal} .sdxbr-batch-fail { color: #b00020; }
        `;
        document.head.appendChild(style);
    }
    function buildDockedButtonEl(page) {
        const btn = document.createElement("button");
        btn.id = IDS.button;
        btn.type = "button";
        btn.dataset.page = page;
        btn.className = "sdxbr-docked";
        btn.textContent = `${WIZARD_ICON} ${TOOL_NAME}`;
        btn.addEventListener("click", openModal);
        return btn;
    }
    function removeDockedButton() {
        document.getElementById(IDS.button)?.remove();
        document.querySelector(".sdxbr-injected-wrap")?.remove();
    }
    // Injects the button INTO the page (no floating/fixed positioning) only on
    // the Add Recipients and Review pages, and follows route changes so it never
    // lingers on the wrong page or covers content elsewhere in SDx.
    function ensureDockedButton() {
        const desired = isAddRecipientPage() ? "add-recipient" : (isReviewPage() ? "review" : null);
        const existing = document.getElementById(IDS.button);
        if (existing && existing.isConnected && existing.dataset.page === desired) {
            return;
        }
        removeDockedButton();
        if (!desired) {
            if (isModalOpen() && !state.batch.active) closeModal();
            return;
        }
        if (desired === "add-recipient") {
            const anchor = document.querySelector('.shell-topbar__title[title="Add Recipients"]');
            if (!anchor) return;
            anchor.insertAdjacentElement("afterend", buildDockedButtonEl(desired));
        } else {
            const anchor = document.querySelector("sda-power-bar-section.power-bar-controls--right");
            if (!anchor) return;
            const wrapper = document.createElement("div");
            wrapper.className = "power-bar-switch sdxbr-injected-wrap";
            wrapper.appendChild(buildDockedButtonEl(desired));
            anchor.insertBefore(wrapper, anchor.firstChild);
        }
    }
    function installModal() {
        if (document.getElementById(IDS.modal)) return;
        const backdrop = document.createElement("div");
        backdrop.id = IDS.backdrop;
        backdrop.addEventListener("click", closeModal);
        const modal = document.createElement("div");
        modal.id = IDS.modal;
        modal.innerHTML = `
            <div class="sdxbr-header">
                <div>
                    <div class="sdxbr-title" id="sdxbrTitle">${WIZARD_ICON} ${TOOL_NAME}</div>
                    <div class="sdxbr-subtitle" id="sdxbrSubtitle">v${VERSION} | Per-project database | Favorites | Zero-click context</div>
                </div>
                <div class="sdxbr-header-right">
                    <span class="sdxbr-session-pill missing" id="sdxbrSessionPill">Session not captured yet</span>
                    <button type="button" class="sdxbr-close" id="sdxbrClose">X</button>
                </div>
            </div>
            <div class="sdxbr-tabs">
                <button type="button" class="sdxbr-tab active" id="sdxbrTabReviewers">Add Reviewers</button>
                <button type="button" class="sdxbr-tab" id="sdxbrTabDatabase">User Database</button>
                <button type="button" class="sdxbr-tab" id="sdxbrTabContext">Debug</button>
            </div>
            <div class="sdxbr-body">
                <div id="sdxbrReviewersPane"></div>
                <div id="sdxbrDatabasePane" style="display:none;"></div>
                <div id="sdxbrContextPane" style="display:none;"></div>
            </div>
            <div class="sdxbr-footer">
                <div class="sdxbr-status" id="sdxbrStatus">Ready.</div>
                <button type="button" class="sdxbr-btn sdxbr-danger" id="sdxbrClearQueue">Clear Queue</button>
                <button type="button" class="sdxbr-btn sdxbr-primary" id="sdxbrAddReviewers">Add Reviewers</button>
            </div>
        `;
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
        document.getElementById("sdxbrClose").addEventListener("click", closeModal);
        document.getElementById("sdxbrTabReviewers").addEventListener("click", () => switchTab("reviewers"));
        document.getElementById("sdxbrTabDatabase").addEventListener("click", () => switchTab("database"));
        document.getElementById("sdxbrTabContext").addEventListener("click", () => switchTab("context"));
        document.getElementById("sdxbrClearQueue").addEventListener("click", clearQueue);
        document.getElementById("sdxbrAddReviewers").addEventListener("click", addQueuedReviewers);
        renderAll();
        updateSessionIndicator();
    }
    function isModalOpen() {
        return Boolean(document.getElementById(IDS.modal)?.classList.contains("open"));
    }
    function openModal() {
        state.batch.active = false;
        loadStoredState();
        installModal();
        document.getElementById(IDS.backdrop)?.classList.add("open");
        document.getElementById(IDS.modal)?.classList.add("open");
        switchTab(isDocumentPage() ? "reviewers" : "database");
        deriveContextFromUrl();
        updateStatus();
        updateSessionIndicator();
        loadExistingRecipients();
    }
    function closeModal() {
        document.getElementById(IDS.backdrop)?.classList.remove("open");
        document.getElementById(IDS.modal)?.classList.remove("open");
        if (state.batch.active) {
            state.batch.active = false;
            state.batch.results = null;
            state.existingRecipients = new Map();
            state.existingRecipientsStatus = "idle";
            state.batch.lastChecked = -1;
            updateModalHeader();
        }
    }
    function switchTab(tab) {
        state.activeTab = tab;
        document.getElementById("sdxbrTabReviewers")?.classList.toggle("active", tab === "reviewers");
        document.getElementById("sdxbrTabDatabase")?.classList.toggle("active", tab === "database");
        document.getElementById("sdxbrTabContext")?.classList.toggle("active", tab === "context");
        document.getElementById("sdxbrReviewersPane").style.display = tab === "reviewers" ? "" : "none";
        document.getElementById("sdxbrDatabasePane").style.display = tab === "database" ? "" : "none";
        document.getElementById("sdxbrContextPane").style.display = tab === "context" ? "" : "none";
        const addBtn = document.getElementById("sdxbrAddReviewers");
        const clearBtn = document.getElementById("sdxbrClearQueue");
        if (addBtn) addBtn.style.display = tab === "reviewers" ? "" : "none";
        if (clearBtn) clearBtn.style.display = tab === "reviewers" ? "" : "none";
        renderAll();
        updateStatus();
    }
    function setStatus(message, warning = false) {
        const el = document.getElementById("sdxbrStatus");
        if (!el) return;
        el.textContent = message;
        el.classList.toggle("warning", Boolean(warning));
    }
    function setDatabaseMessage(message, warning = false) {
        const el = document.getElementById("sdxbrDatabaseMessage");
        if (!el) return;
        el.textContent = message;
        el.classList.toggle("warning", Boolean(warning));
    }
    function setReviewerBusy(busy) {
        for (const id of ["sdxbrSearch", "sdxbrClearQueue", "sdxbrAddReviewers"]) {
            const el = document.getElementById(id);
            if (el) el.disabled = busy;
        }
    }
    function setDatabaseBusy(busy) {
        for (const id of ["sdxbrBuildDb", "sdxbrClearDb"]) {
            const el = document.getElementById(id);
            if (el) el.disabled = busy;
        }
    }
    function showProgressBar(visible) {
        const wrap = document.getElementById("sdxbrProgressWrap");
        if (!wrap) return;
        wrap.style.display = visible ? "" : "none";
        if (!visible) setProgress(0, 1, "");
    }
    function setProgress(current, total, label) {
        const fill = document.getElementById("sdxbrProgressFill");
        const labelEl = document.getElementById("sdxbrProgressLabel");
        const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
        if (fill) fill.style.width = pct + "%";
        if (labelEl) labelEl.textContent = label;
    }
    function updateSessionIndicator() {
        const el = document.getElementById("sdxbrSessionPill");
        if (!el) return;
        if (state.authStale) {
            el.textContent = "Session expired - click a filter in SDx";
            el.className = "sdxbr-session-pill stale";
        } else if (state.authHeaders.authorization) {
            el.textContent = "Session captured";
            el.className = "sdxbr-session-pill ok";
        } else {
            el.textContent = "Session not captured yet";
            el.className = "sdxbr-session-pill missing";
        }
    }
    function updateStatus() {
        if (!document.getElementById("sdxbrStatus")) return;
        if (state.activeTab === "database") {
            const selected = Array.from(state.selectedOrgs).join(", ") || "None";
            setStatus(`Project ${state.projectKey}: database users cached: ${state.userCache.size}. Selected organizations: ${selected}.`, state.orgSelectionDirty);
            return;
        }
        if (state.activeTab === "context") {
            const ready = Boolean(state.addEndpoint && state.addTemplate.workFlowStepOBIDs.length);
            setStatus(ready ? "Add Recipients context is ready." : "Add Recipients context is missing for this document.", !ready);
            return;
        }
        if (!state.userCache.size) {
            setStatus(`Reviewer database for project ${state.projectKey} is empty. Open User Database and build it.`, true);
            return;
        }
        if (!state.addEndpoint || !state.addTemplate.workFlowStepOBIDs.length) {
            setStatus("Reviewer database is ready, but this document's Add Recipients context is missing. Try reopening the tool here.", true);
            return;
        }
        if (state.batch.active) {
            setStatus(`Ready. Cached users: ${state.userCache.size}. Adding to ${includedBatchDocs().length} of ${state.batch.docs.length} selected documents.`);
            return;
        }
        setStatus(`Ready. Cached users: ${state.userCache.size}. Workflow step: ${state.addTemplate.workFlowStepOBIDs.join(", ")}.`);
    }
    function renderAll() {
        updateModalHeader();
        renderReviewersTab();
        renderDatabaseTab();
        renderContextPanel();
        renderResults();
        renderQueue();
        renderRecents();
        renderFavorites();
        renderExistingRecipients();
        updateSessionIndicator();
    }
    function renderReviewersTab() {
        const pane = document.getElementById("sdxbrReviewersPane");
        if (!pane) return;
        pane.innerHTML = `
            ${!state.userCache.size ? `
            <div class="sdxbr-note" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                <span>No reviewer database found yet for project <strong>${escapeHtml(state.projectKey)}</strong>. Search won't find anyone until you build one.</span>
                <button type="button" class="sdxbr-btn sdxbr-primary" id="sdxbrGoBuildDb">Build Database</button>
            </div>` : ""}
            ${state.showRefreshPrompt ? `
            <div class="sdxbr-refresh-banner">
                <span>Reviewers were added. Refresh the page to confirm they show up correctly.</span>
                <button type="button" class="sdxbr-btn sdxbr-primary" id="sdxbrRefreshPageBtn">Refresh Page</button>
            </div>` : ""}
            <div class="sdxbr-panel" style="margin-bottom:12px;">
                <div class="sdxbr-panel-title">
                    <span>${state.batch.active ? "Selected Documents" : "Already On This Document"}</span>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <span class="sdxbr-existing-status" id="sdxbrExistingStatus">Not loaded yet.</span>
                        <button type="button" class="sdxbr-mini-btn" id="sdxbrRefreshExisting">Refresh</button>
                    </div>
                </div>
                <div class="sdxbr-panel-body sdxbr-existing-body ${state.batch.active ? "sdxbr-batch-body" : ""}" id="sdxbrExisting" style="padding:8px;"></div>
            </div>
            <div class="sdxbr-toolbar" style="grid-template-columns: 1fr; margin-bottom:12px;">
                <input id="sdxbrSearch" type="text" placeholder="Search cached reviewers by name, login, email, organization, or Id - typos OK">
            </div>
            <div class="sdxbr-workspace">
                <div class="sdxbr-sidebar">
                    <div class="sdxbr-panel sdxbr-favorites-panel">
                        <div class="sdxbr-panel-title">
                            <span>Favorites</span>
                            <span class="sdxbr-pill">${getFavorites().length}</span>
                        </div>
                        <div class="sdxbr-panel-body" id="sdxbrFavorites"></div>
                    </div>
                    <div class="sdxbr-panel sdxbr-recents-panel">
                        <div class="sdxbr-panel-title">
                            <span>Recently Added</span>
                        </div>
                        <div class="sdxbr-panel-body" id="sdxbrRecents"></div>
                    </div>
                </div>
                <div class="sdxbr-main">
                    <div class="sdxbr-main-row">
                        <div class="sdxbr-panel">
                            <div class="sdxbr-panel-title">
                                <span>Search Results</span>
                                <span class="sdxbr-pill">${state.searchResults.length}</span>
                            </div>
                            <div class="sdxbr-panel-body" id="sdxbrResults"></div>
                        </div>
                        <div class="sdxbr-panel">
                            <div class="sdxbr-panel-title">
                                <span>To Be Added</span>
                                <span class="sdxbr-pill">${state.queued.size}</span>
                            </div>
                            <div class="sdxbr-panel-body" id="sdxbrQueue"></div>
                        </div>
                    </div>
                    <div class="sdxbr-panel sdxbr-addedpage-panel">
                        <div class="sdxbr-panel-title">
                            <span>Added This Page</span>
                            <span class="sdxbr-pill">${state.addedThisPage.size}</span>
                        </div>
                        <div class="sdxbr-panel-body">
                            ${renderAddedThisPageHtml()}
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById("sdxbrSearch").addEventListener("input", debounce(e => {
            searchCachedUsers(e.target.value);
        }, 150));
        document.getElementById("sdxbrRefreshExisting").addEventListener("click", () => loadExistingRecipients());
        document.getElementById("sdxbrRefreshPageBtn")?.addEventListener("click", () => location.reload());
        document.getElementById("sdxbrGoBuildDb")?.addEventListener("click", () => switchTab("database"));
    }
    function renderDatabaseTab() {
        const pane = document.getElementById("sdxbrDatabasePane");
        if (!pane) return;
        const selectedText = Array.from(state.selectedOrgs).join(", ") || "None";
        pane.innerHTML = `
            <div class="sdxbr-note">
                <strong>This database is scoped to project ${escapeHtml(state.projectKey)} only.</strong>
                Other projects keep their own separate database, so reviewers from one client/project never show up
                as options on another. By default only <strong>Burns &amp; McDonnell</strong> employees show up.
                Check other organizations below, then click <strong>Build Database</strong> - it scans every
                organization and caches your selected ones in a single pass.
            </div>
            <div class="sdxbr-panel">
                <div class="sdxbr-panel-title">
                    <span>User Database Settings</span>
                    <span class="sdxbr-pill">${state.userCache.size} cached users</span>
                </div>
                <div class="sdxbr-panel-body" style="padding:10px; max-height:none;">
                    <div><strong>Current project:</strong> ${escapeHtml(state.projectKey)}</div>
                    <div><strong>Selected organizations:</strong> ${escapeHtml(selectedText)}</div>
                    <div><strong>Known organizations:</strong> ${state.orgIndex.size}</div>
                    <div><strong>Data source:</strong> /ENR01Server/api/v2/SDA/BMCDLoginUsers</div>
                    <div class="sdxbr-db-actions">
                        <button type="button" class="sdxbr-btn sdxbr-primary" id="sdxbrBuildDb">Build Database</button>
                        <button type="button" class="sdxbr-btn sdxbr-danger" id="sdxbrClearDb">Clear Database</button>
                    </div>
                    <div class="sdxbr-progress-wrap" id="sdxbrProgressWrap" style="display:none;">
                        <div class="sdxbr-progress-bar"><div class="sdxbr-progress-fill" id="sdxbrProgressFill"></div></div>
                        <div class="sdxbr-progress-label" id="sdxbrProgressLabel">Starting...</div>
                    </div>
                    <div id="sdxbrDatabaseMessage" class="sdxbr-status ${state.orgSelectionDirty ? "warning" : ""}">
                        ${state.orgSelectionDirty
                            ? "Organization selection changed. Rebuild the user database before using the updated list."
                            : "Ready."}
                    </div>
                </div>
            </div>
            <div class="sdxbr-panel" style="margin-top:12px;">
                <div class="sdxbr-panel-title">
                    <span>Organization Selection</span>
                    <span class="sdxbr-pill">${state.selectedOrgs.size} selected</span>
                </div>
                <div class="sdxbr-panel-body" style="padding:0; max-height:340px;">
                    ${renderOrgListHtml()}
                </div>
            </div>
        `;
        document.getElementById("sdxbrBuildDb").addEventListener("click", buildDatabase);
        document.getElementById("sdxbrClearDb").addEventListener("click", clearUserCache);
        pane.querySelectorAll(".sdxbrOrgCheck").forEach(check => {
            check.addEventListener("change", () => {
                const org = check.dataset.org;
                if (check.checked) state.selectedOrgs.add(org);
                else state.selectedOrgs.delete(org);
                saveSelectedOrgs();
                state.orgSelectionDirty = true;
                renderDatabaseTab();
                setStatus("Organization selection changed. Rebuild the user database.", true);
            });
        });
    }
    function renderOrgListHtml() {
        const entries = Array.from(state.orgIndex.entries())
            .sort((a, b) => {
                const aDefault = DEFAULT_SELECTED_ORGS.includes(a[0]) ? -1 : 0;
                const bDefault = DEFAULT_SELECTED_ORGS.includes(b[0]) ? -1 : 0;
                if (aDefault !== bDefault) return aDefault - bDefault;
                return a[0].localeCompare(b[0]);
            });
        if (!entries.length) {
            return `
                <div class="sdxbr-muted">
                    No organizations found yet. Click <strong>Build Database</strong> - it discovers every
                    organization on this project automatically. Burns &amp; McDonnell is selected by default.
                </div>
            `;
        }
        return `
            <div class="sdxbr-org-list">
                ${entries.map(([org, count]) => {
                    const checked = state.selectedOrgs.has(org) ? "checked" : "";
                    return `
                        <label class="sdxbr-org-row">
                            <input type="checkbox" class="sdxbrOrgCheck" data-org="${escapeHtml(org)}" ${checked}>
                            <span>${escapeHtml(org)}</span>
                            <span class="sdxbr-pill">${escapeHtml(count)}</span>
                        </label>
                    `;
                }).join("")}
            </div>
        `;
    }
    function renderContextPanel() {
        const pane = document.getElementById("sdxbrContextPane");
        if (!pane) return;
        const workflow = state.addTemplate.workFlowStepOBIDs.length
            ? state.addTemplate.workFlowStepOBIDs.join(", ")
            : (state.batch.active ? "No documents included" : "Not captured");
        pane.innerHTML = `
            <div class="sdxbr-note">
                Debug info only - not needed for normal use. Workflow context is derived directly from this
                document's URL, so it should be ready as soon as the tool opens. If it's ever missing, try closing
                and reopening the tool on this page.
            </div>
            <div class="sdxbr-panel">
                <div class="sdxbr-panel-title">
                    <span>Current Page Context</span>
                    <span class="sdxbr-pill">${state.addEndpoint && state.addTemplate.workFlowStepOBIDs.length ? "Ready" : "Missing"}</span>
                </div>
                <div class="sdxbr-panel-body" style="max-height:none;">
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Project:</span> ${escapeHtml(state.projectKey)}
                    </div>
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Document OBID:</span> ${escapeHtml(state.documentOBID || "Not captured")}
                    </div>
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Workflow Step:</span> ${escapeHtml(workflow)}
                    </div>
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Add Endpoint:</span> ${escapeHtml(state.addEndpoint ? "Captured" : "Not captured")}
                    </div>
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Step Definition:</span> ${escapeHtml(state.addTemplate.stepDefName || "Not captured")}
                    </div>
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Template:</span> ${escapeHtml(state.addTemplate.workFlowTemplateName || "Not captured")}
                    </div>
                    <div class="sdxbr-context-line">
                        <span class="sdxbr-context-label">Session:</span> ${escapeHtml(state.authHeaders.authorization ? `Captured${state.authHeaders.capturedAt ? " at " + new Date(state.authHeaders.capturedAt).toLocaleString() : ""}` : "Not captured yet")}
                    </div>
                </div>
            </div>
        `;
    }
    function rowDisabledState(id) {
        if (state.existingRecipients.has(id)) return { label: "On Document", disabled: "disabled" };
        if (state.queued.has(id)) return { label: "Queued", disabled: "disabled" };
        if (state.addedThisPage.has(id)) return { label: "Added", disabled: "disabled" };
        return { label: "Queue", disabled: "" };
    }
    function renderResults() {
        const container = document.getElementById("sdxbrResults");
        if (!container) return;
        if (!state.searchResults.length) {
            container.innerHTML = state.userCache.size
                ? `<div class="sdxbr-muted">No results, even allowing for typos. Try rebuilding with more organizations selected in User Database.</div>`
                : `<div class="sdxbr-muted">No reviewer database loaded for this project yet. Open <strong>User Database</strong> and click <strong>Build Database</strong> first.</div>`;
            return;
        }
        container.innerHTML = state.searchResults.map(user => {
            const id = getUserId(user);
            const { label, disabled } = rowDisabledState(id);
            const fav = isFavorite(id);
            return `
                <div class="sdxbr-user-row">
                    <div>
                        <div class="sdxbr-user-name">${escapeHtml(getUserName(user))}</div>
                        <div class="sdxbr-user-meta">${escapeHtml(getUserMetaShort(user))}</div>
                    </div>
                    <div class="sdxbr-row-actions">
                        <button type="button" class="sdxbr-mini-btn sdxbr-star-btn ${fav ? "active" : ""}" data-id="${escapeHtml(id)}" title="${fav ? "Remove from favorites" : "Add to favorites"}">${fav ? "&#9733;" : "&#9734;"}</button>
                        <button type="button" class="sdxbr-mini-btn sdxbrQueueBtn" data-id="${escapeHtml(id)}" ${disabled}>${label}</button>
                    </div>
                </div>
            `;
        }).join("");
        container.querySelectorAll(".sdxbrQueueBtn").forEach(btn => {
            btn.addEventListener("click", () => queueUser(btn.dataset.id));
        });
        container.querySelectorAll(".sdxbr-star-btn").forEach(btn => {
            btn.addEventListener("click", () => toggleFavorite(btn.dataset.id));
        });
    }
    function renderQueue() {
        const container = document.getElementById("sdxbrQueue");
        if (!container) return;
        const users = Array.from(state.queued.values());
        if (!users.length) {
            container.innerHTML = `<div class="sdxbr-muted">No reviewers queued.</div>`;
            return;
        }
        container.innerHTML = users.map(user => {
            const id = getUserId(user);
            const fav = isFavorite(id);
            return `
                <div class="sdxbr-user-row">
                    <div>
                        <div class="sdxbr-user-name">${escapeHtml(getUserName(user))}</div>
                        <div class="sdxbr-user-meta">${escapeHtml(getUserMetaShort(user))}</div>
                    </div>
                    <div class="sdxbr-row-actions">
                        <button type="button" class="sdxbr-mini-btn sdxbr-star-btn ${fav ? "active" : ""}" data-id="${escapeHtml(id)}" title="${fav ? "Remove from favorites" : "Add to favorites"}">${fav ? "&#9733;" : "&#9734;"}</button>
                        <button type="button" class="sdxbr-mini-btn sdxbrRemoveBtn" data-id="${escapeHtml(id)}">Remove</button>
                    </div>
                </div>
            `;
        }).join("");
        container.querySelectorAll(".sdxbrRemoveBtn").forEach(btn => {
            btn.addEventListener("click", () => removeQueued(btn.dataset.id));
        });
        container.querySelectorAll(".sdxbr-star-btn").forEach(btn => {
            btn.addEventListener("click", () => toggleFavorite(btn.dataset.id));
        });
    }
    function renderRecents() {
        const container = document.getElementById("sdxbrRecents");
        if (!container) return;
        const recents = readJson(storeKey(STORE.recentsPrefix), []);
        if (!recents.length) {
            container.innerHTML = `<div class="sdxbr-muted">No recent reviewers yet for this project.</div>`;
            return;
        }
        container.innerHTML = recents.slice(0, 20).map(user => {
            const fav = isFavorite(user.Id);
            const { label, disabled } = rowDisabledState(user.Id);
            return `
                <div class="sdxbr-user-row">
                    <div>
                        <div class="sdxbr-user-name">${escapeHtml(user.Name || user.Id)}</div>
                        <div class="sdxbr-user-meta">${escapeHtml(getUserMetaShort(user))}</div>
                    </div>
                    <div class="sdxbr-row-actions">
                        <button type="button" class="sdxbr-mini-btn sdxbr-star-btn ${fav ? "active" : ""}" data-id="${escapeHtml(user.Id)}" title="${fav ? "Remove from favorites" : "Add to favorites"}">${fav ? "&#9733;" : "&#9734;"}</button>
                        <button type="button" class="sdxbr-mini-btn sdxbrRecentBtn" data-id="${escapeHtml(user.Id)}" ${disabled}>${label}</button>
                    </div>
                </div>
            `;
        }).join("");
        container.querySelectorAll(".sdxbrRecentBtn").forEach(btn => {
            btn.addEventListener("click", () => queueRecent(btn.dataset.id));
        });
        container.querySelectorAll(".sdxbr-star-btn").forEach(btn => {
            btn.addEventListener("click", () => toggleFavorite(btn.dataset.id));
        });
    }
    function renderFavorites() {
        const container = document.getElementById("sdxbrFavorites");
        if (!container) return;
        const favorites = getFavorites();
        if (!favorites.length) {
            container.innerHTML = `<div class="sdxbr-muted">No favorites yet for this project. Click the star (&#9734;) next to any reviewer to pin them here.</div>`;
            return;
        }
        container.innerHTML = favorites.map(user => {
            const id = user.Id;
            const { label, disabled } = rowDisabledState(id);
            return `
                <div class="sdxbr-user-row">
                    <div>
                        <div class="sdxbr-user-name">${escapeHtml(user.Name || user.Id)}</div>
                        <div class="sdxbr-user-meta">${escapeHtml(getUserMetaShort(user))}</div>
                    </div>
                    <div class="sdxbr-row-actions">
                        <button type="button" class="sdxbr-mini-btn sdxbr-star-btn active" data-id="${escapeHtml(id)}" title="Remove from favorites">&#9733;</button>
                        <button type="button" class="sdxbr-mini-btn sdxbrFavQueueBtn" data-id="${escapeHtml(id)}" ${disabled}>${label}</button>
                    </div>
                </div>
            `;
        }).join("");
        container.querySelectorAll(".sdxbrFavQueueBtn").forEach(btn => {
            btn.addEventListener("click", () => queueFavorite(btn.dataset.id));
        });
        container.querySelectorAll(".sdxbr-star-btn").forEach(btn => {
            btn.addEventListener("click", () => toggleFavorite(btn.dataset.id));
        });
    }
    function renderExistingRecipients() {
        const container = document.getElementById("sdxbrExisting");
        const statusEl = document.getElementById("sdxbrExistingStatus");
        if (state.batch.active) {
            if (container) renderBatchPanel(container, statusEl);
            return;
        }
        if (statusEl) {
            const map = {
                idle: "Not loaded yet.",
                loading: "Loading current recipients...",
                auth: "Session expired - click a filter in SDx, then Refresh.",
                error: "Could not load current recipients. Click Refresh to retry.",
                ready: `${state.existingRecipients.size} already on this document.`
            };
            statusEl.textContent = map[state.existingRecipientsStatus] || map.idle;
        }
        if (!container) return;
        const users = Array.from(state.existingRecipients.values());
        if (!users.length) {
            container.innerHTML = `<div class="sdxbr-muted">${state.existingRecipientsStatus === "loading" ? "Loading..." : "No existing recipients loaded."}</div>`;
            return;
        }
        container.innerHTML = users
            .sort((a, b) => String(a.DisplayName || "").localeCompare(String(b.DisplayName || "")))
            .map(u => `<span class="sdxbr-chip" title="OBID: ${escapeHtml(u.OBID)}">${escapeHtml(u.DisplayName || u.OBID)}${u.IsReviewer ? "" : " (no review yet)"}</span>`)
            .join("");
    }
    function renderAddedThisPageHtml() {
        const users = Array.from(state.addedThisPage.values());
        if (!users.length) {
            return `<div class="sdxbr-muted">No reviewers added through this tool on this page yet.</div>`;
        }
        return users.map(user => {
            return `
                <div class="sdxbr-user-row">
                    <div>
                        <div class="sdxbr-user-name">${escapeHtml(getUserName(user))}</div>
                        <div class="sdxbr-user-meta">${escapeHtml(getUserMetaShort(user))}</div>
                    </div>
                    <span class="sdxbr-pill">Added</span>
                </div>
            `;
        }).join("");
    }
    /************************************************************
     * Activation
     ************************************************************/
    // Perf notes (v0.9):
    // 1. Recomputing the project/page key (which can fall back to reading
    //    document.body.innerText - a full-page layout read) only needs to
    //    happen when the URL actually changed, so that work stays behind the
    //    href-diff guard below.
    // 2. v0.8 introduced a regression: it called the FULL loadStoredState()
    //    (which JSON.parses the entire per-project reviewer cache - potentially
    //    thousands of records) every time the PAGE key changed, which includes
    //    just opening a different document in the SAME project. That meant
    //    every single document you opened re-parsed the whole database from
    //    localStorage in the background, whether or not the tool was even open.
    //    That's a much more plausible source of "everything in SDx feels slow"
    //    than the interval itself. Fixed: the heavy per-project reload
    //    (loadProjectScopedState) now only runs when the PROJECT changes, not
    //    on every document open within the same project.
    // 3. ensureDockedButton()/installStyles() must run on EVERY tick, not only
    //    when the href changes. They're cheap (a couple of DOM lookups) and
    //    idempotent, but the Review page's power-bar anchor can mount
    //    asynchronously after the route change - if we only check once at
    //    navigation time and the anchor isn't there yet, we'd never retry. This
    //    was the cause of the button disappearing on Review pages in v0.8.
    function activateIfNeeded() {
        installNetworkHooks();
        if (!isSdxPage()) {
            if (state.lastHref) {
                state.lastHref = "";
                removeDockedButton();
            }
            return;
        }
        const currentHref = location.href;
        if (state.batch.active && !isTodoListPage()) {
            // Navigated away from the To Do List while the batch window was open.
            closeModal();
        }
        if (currentHref !== state.lastHref && state.batch.active) {
            // Batch mode owns projectKey/context while its window is open; the To
            // Do List URL changing (filters, sorting) must not clobber it.
            state.lastHref = currentHref;
        } else if (currentHref !== state.lastHref) {
            state.lastHref = currentHref;
            const oldProject = state.projectKey;
            const oldPage = state.pageKey;
            state.projectKey = getProjectKeyFromPage();
            state.pageKey = getPageKeyFromUrl();
            if (oldProject !== state.projectKey) {
                loadProjectScopedState();
            }
            if (oldProject !== state.projectKey || oldPage !== state.pageKey) {
                loadPageContext();
                if (isDocumentPage()) {
                    resetPerDocumentPage();
                }
            }
            if (isDocumentPage()) {
                const gotContext = deriveContextFromUrl();
                if (gotContext && isModalOpen() && oldPage !== state.pageKey) {
                    loadExistingRecipients();
                }
            }
        }
        // Cheap and idempotent - must run every tick regardless of whether the
        // URL changed, so the button can appear once its anchor finally mounts.
        installStyles();
        installBatchStyles();
        ensureDockedButton();
        ensureBatchButton();
    }
    function monitorNavigation() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        history.pushState = function () {
            const result = originalPushState.apply(this, arguments);
            setTimeout(activateIfNeeded, 300);
            return result;
        };
        history.replaceState = function () {
            const result = originalReplaceState.apply(this, arguments);
            setTimeout(activateIfNeeded, 300);
            return result;
        };
        window.addEventListener("hashchange", () => setTimeout(activateIfNeeded, 300));
        window.addEventListener("popstate", () => setTimeout(activateIfNeeded, 300));
        setInterval(activateIfNeeded, 1500);
    }
    // Update the batch button promptly when To Do List rows are (un)checked;
    // the 1.5s tick in activateIfNeeded() is the safety net (e.g. select-all).
    for (const evt of ["click", "change"]) {
        document.addEventListener(evt, e => {
            if (e.target && e.target.closest && e.target.closest(TODO_CHECKBOX_SELECTOR)) {
                setTimeout(ensureBatchButton, 60);
            }
        }, true);
    }
    installNetworkHooks();
    loadStoredState();
    monitorNavigation();
    activateIfNeeded();
})();
 
