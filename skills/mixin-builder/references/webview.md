# Webview — bot as an app

A Mixin bot is two surfaces: the **chat** (Blaze messages → messaging.md) and an embedded **webview** the client opens over your web app. The page runs in Messenger's in-app browser, gets a context object, and can call a small native bridge. All bridge facts below are the verified Node SDK 7.6.0 `WebViewApi` surface (`dist/index.d.ts` + `dist/index.js`); design rules are distilled from the official design docs.

## Handoff into the webview

Users open the bot homepage via (docs: app/design/user-interaction.md): the **bot icon at the chat bottom**, the **lower-left chat menu** (group/shared bots), or the **bot profile popup**. That loads the dashboard-configured **Home URL**.

Programmatic handoff from chat: send an **APP_CARD** (Go `BlazeClient.SendAppCard(convId, recipientId, title, description, action, iconUrl)`; Node `message.sendAppCard`) whose `action` is your page URL, e.g. `https://your-app.example/dashboard`. Messenger opens it in the webview on tap.

> **Dashboard whitelist is mandatory**: "Resource Patterns" in the dashboard is "a whitelist used to prevent fake bot links. When opening card and button type messages, it will check whether the linked domain name is in the whitelist. For `APP_CARD` or `APP_BUTTON_GROUP` messages, you need to ensure that the `action` is in the whitelist." (docs: app/getting-started/create-app.md) Without a matching pattern the card/button will not open. `APP_BUTTON_GROUP` buttons also support the command form `action: "input:subscribe"` — tapping auto-sends that text to the bot (docs: app/design/user-interaction.md).

The chat the user came from is observable inside the page: `getMixinContext().conversation_id` (and `platform`) — use it to key per-chat state, send follow-up messages to the right conversation, etc.

## JS bridge — `WebViewApi()`

Import from `@mixin.dev/mixin-node-sdk` (7.6.0):

| Call | Returns / callback | Purpose |
|---|---|---|
| `getMixinContext()` | `Context` (below) | Client + chat context |
| `reloadTheme()` | — | Re-extract `theme-color` after you change it dynamically |
| `playlist(urls)` | — | Play audio playlist natively |
| `close()` | — | Close webview → back to chat |
| `getAssets([asset_ids], cb)` | `cb(WebviewAsset[])` | User balances for given assets |
| `getTipAddress(chainId, cb)` | `cb(address)` | User's TIP address on a chain |
| `tipSign(chainId, msg, cb)` | `cb(signature)` | User TIP-signs a message on a chain |

```ts
interface Context {
  app_version?: string;
  immersive?: boolean;
  appearance?: 'light' | 'dark';
  currency?: string;
  locale?: string;
  platform?: 'iOS' | 'Android' | 'Desktop';
  conversation_id?: string;
}
interface WebviewAsset { asset_id, balance, chain_id, icon_url, name, symbol: string }
```

(node: dist/index.d.ts 7.6.0)

### Bridge plumbing (why the wrapper exists)

- **iOS (WebKit)**: native handlers at `window.webkit.messageHandlers.{MixinContext,reloadTheme,playlist,close,getAssets,getTipAddress,tipSign}`; `getMixinContext` is implemented via `prompt('MixinContext.getContext()')` returning a JSON string, and defaults `platform` to `'iOS'`.
- **Android/Desktop**: direct `window.MixinContext.getContext()` (JSON string) / `.reloadTheme()` / `.playlist(audios)` / `.close()` / `.getAssets(ids, globalCallbackName)` …; `platform` defaults to `'Android'`.
- Callback methods register a throwaway global (`mixinAssetsCallback_<ts>_<rand>` for getAssets; fixed `tipAddressCallbackFunction` / `tipSignCallbackFunction` for TIP) that the native side invokes with a JSON string; the wrapper parses and deletes it.
- **Outside Messenger** (plain browser) both bridges are absent: `getMixinContext()` returns `{}` and `platform` is `undefined` — guard every call, e.g. `const ctx = WebViewApi().getMixinContext(); if (!ctx.platform) /* web fallback */`.

Keep using the SDK wrapper rather than poking `window.webkit` yourself — it already handles the platform switch, JSON parsing, and callback hygiene.

### Theme

- Advertise your theme color; Messenger colors the status bar / title bar from it: `<meta name="theme-color" content="#673ab8">` (docs: app/design/color.md). No gradients.
- Dark mode: the client follows the system appearance automatically; in-page, react to `prefers-color-scheme` media queries and/or read `ctx.appearance` (`'light' | 'dark'`). Call `reloadTheme()` after swapping `theme-color` dynamically (docs: app/design/dark-mode.md).
- For full-screen layouts enable **Immersive mode** in the dashboard (Information → Immersive checkbox): you control everything except the status bar; `ctx.immersive` reflects it in-page (docs: app/design/immersive-mode.md).

## Design conventions (docs: app/design/*)

- **Title bar** (title-bar.md): default bots get a fixed title bar showing the bot icon + name — you don't control it; account for it in layout.
- **Floating menu** (floating-menu.md): a fixed capsule in the **upper-right** with share / floating window / about / refresh is always rendered. Reserve that corner — never put interactive elements where it occludes them (double rule in immersive mode).
- **Consistency & hierarchy** (overview.md): consistent fonts/colors/buttons across pages; one clear highlight per page; follow platform (iOS/Android) conventions.
- **Minimize input** (overview.md): prefer pickers and authorization (OAuth, phone scope) over typing; pre-fill what context gives you (`currency`, `locale`).
- **Perceived performance** (overview.md): avoid long waits; when unavoidable show loading animation, progress bar + cancel button.
- **Notifications** (overview.md): only push important events; let users opt into push types or they will mute/block the bot.
- **Buttons** (color.md): use the provided 24-color palette (e.g. `0x7983C2, 0x8F7AC5, 0xC5595A, 0xC97B46, 0x76A048, 0x3D98D0, …` full list in the doc) — tuned for both light and dark modes.
- **Stickers** (sticker.md): sticker *albums* are artist submissions (9–30 WebP/Lottie stickers, 256–512 px each, `manifest.json` + `banner.png` + `thumb.webp`, zip with copyright notice sent to Mixin Messenger 1039549) — not a webview feature; bots only *consume* stickers as `PLAIN_STICKER` messages. Don't over-invest here for app bots.
- **Chat-side patterns** (user-interaction.md): on first "Hello" reply with an intro + APP_BUTTON opening the homepage; keyword auto-replies for common questions, escalate the rest to customer service; push short updates as text, long ones as POST articles (markdown → send to bot 7000103014 to convert); `input:`-action buttons for one-tap commands.

## Auth inside the webview

`getMixinContext()` is **context, not authentication**: `conversation_id` identifies the chat and `platform` the client, but any page can read it. Escalate per need:

- **Full identity**: run the OAuth flow from inside the webview (→ identity-and-keys.md) — authorize URL with your `client_id`/`scope`, PKCE exchange; store per-user server-side.
- **Balance proofs**: `getAssets(ids, cb)` returns the user's balances for chosen assets — use to pre-select payment asset.
- **Action proofs**: `getTipAddress` / `tipSign` produce chain-scoped TIP addresses/signatures the user cannot forge without their TIP key; verify server-side (TIP body rules → identity-and-keys.md).

## Verify it worked

- **Open on all three platforms**: `getMixinContext().platform` must report `iOS` / `Android` / `Desktop` respectively on real devices; in a desktop browser without Messenger it returns `{}` — confirm your fallback renders.
- **Handoff + whitelist**: from chat, tap your APP_CARD → page opens in webview (not external browser); `conversation_id` matches the chat you sent the card to; with the domain removed from Resource Patterns the tap no longer opens it.
- **Theme**: flip OS light/dark → page follows (`prefers-color-scheme` / `ctx.appearance`), title/status bar color matches `theme-color`; after dynamic change `reloadTheme()` recolors the chrome.
- **Bridge calls**: `getAssets(['c94ac88f-…'])` callback returns the XIN balance; `close()` returns to the chat.

## Sources

- node: `@mixin.dev/mixin-node-sdk` 7.6.0 — `dist/index.d.ts` (WebViewApi, Context, WebviewAsset, window bridges), `dist/index.js` (WebViewApi implementation, prompt/callback plumbing)
- docs: app/getting-started/create-app.md (Home URL, Resource Patterns, Immersive)
- docs: app/design/{overview,title-bar,dark-mode,immersive-mode,floating-menu,color,sticker,user-interaction}.md (HEAD 2026-10-05)
- go: bot-api-go-client v3.25.7 blaze.go `SendAppCard`; APP_CARD payload limits → messaging.md
