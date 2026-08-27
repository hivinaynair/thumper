# SoundCloud-linked free-download gates (2026)

**Research date:** 2026-08-27  
**Scope:** Third-party pages linked from SoundCloud tracks that exchange a downloadable file or destination URL for fan actions. Primary sources establish product behavior and current status; public open-source projects are used only as implementation evidence.

## Executive conclusion

For preservation, recognize these URLs but do **not** automate social actions or bypass gates. The practical order is:

1. **Hypeddit** — highest priority. It is clearly active, explicitly markets SoundCloud-linked download gates, and can host the uploaded file or gate a destination link. Since June 2026, its SoundCloud actions are voluntary because its SoundCloud API connection is paused.
2. **PumpYourSound** — high discovery priority, but do not auto-complete. Multiple current 2026 SoundCloud-linked campaigns exist and expose SoundCloud follow/comment/repost/like steps.
3. **GateRush** — high discovery priority. Multiple 2026 SoundCloud links were observed and the vendor describes hosted files plus short-lived SoundCloud OAuth, but Cloudflare bot protection and unverified post-June enforcement make headless use fragile.
4. **Droploud** — high discovery priority. A current 2026 SoundCloud campaign and first-party July 2026 gate terms establish hosted files and SoundCloud OAuth actions. Its terms expressly ban scripts and replaying download URLs.
5. **PUSH.fm Reward Links** — medium priority. A July 2026 SoundCloud track links to a Reward Link; PUSH.fm supports hosted files, secret text, and destination URLs. Its SoundCloud follow action is explicitly non-mandatory.
6. **linksr.io** — medium-low priority. A live SoundCloud-linked gate advertises automatic follow/repost/like/comment, but primary product/legal documentation is sparse.

Also recognize **Backstaged Drops, Premierely, Beltergate, Fangate.eu, and Valorizd** as active gate products whose SoundCloud-linked prevalence is not established. Keep **ToneDen, Click.DJ, and Hive** as legacy/operationally uncertain recognizers. Treat **Feature.fm and found.ee** as adjacent action/unlock products rather than proven SoundCloud file-gate priorities.

No platform publishes a reliable metric for the number or share of SoundCloud tracks linking to it. Accordingly, this report does **not** call any candidate “common”; prevalence is **uncertain**. Vendor-wide claims such as ToneDen's “over one million creators and businesses” or found.ee's “over 25,000 creators” do not measure SoundCloud download-gate links ([ToneDen](https://www.toneden.io/), [found.ee](https://console.found.ee/)).

## Cross-platform constraints

- SoundCloud's native download button returns the uploader's original file only when the uploader enables downloads; listeners must be signed in, and anonymous native downloads are not permitted ([SoundCloud Help: Downloading tracks](https://help.soundcloud.com/hc/en-us/articles/115003448787-Downloading-tracks), [Enabling downloads](https://help.soundcloud.com/hc/en-us/articles/115003565708-Enabling-downloads-for-your-track)).
- A third-party gate's file is independent of the SoundCloud upload. It may be an MP3, WAV, FLAC, ZIP, or an external link, and must not be assumed to be the SoundCloud original.
- SoundCloud OAuth is now OAuth 2.1 with PKCE. User-scoped actions require explicit authentication and consent ([API Guide](https://developers.soundcloud.com/docs/api/guide), [OAuth migration](https://developers.soundcloud.com/blog/oauth-migration/)).
- SoundCloud prohibits repetitive automated follows, comments, logins, or other activity that misrepresents popularity. Its API terms permit account actions only when “specifically and deliberately initiated” by the authenticated user, prohibit scraping, and prohibit API apps from adding file-save/offline-download functionality ([SoundCloud Terms, September 2025](https://pages.soundcloud.com/terms-of-use/09-2025), [API Terms](https://developers.soundcloud.com/docs/api/terms-of-use)).
- SoundCloud staff has said it did not categorically block download-gate services, so the June 2026 state must be treated as app-specific rather than a platform-wide technical fact ([SoundCloud API issue #550](https://github.com/soundcloud/api/issues/550)).
- A Modal worker can technically run Chromium, preserve cookies, follow redirects, and capture a browser-authorized download. That does not make unattended gate completion authorized. OAuth, consent screens, email verification, CAPTCHA/anti-bot checks, short-lived signed URLs, and DOM changes make it fragile even before policy concerns.

## Ranked active candidates with current SoundCloud linkage

### 1. Hypeddit — active; direct file and redirect modes

**Current evidence.** Hypeddit's current homepage advertises “Download gates” and “Link gates.” Download gates exchange music for actions; link gates reveal a secret destination ([Hypeddit homepage](https://hypeddit.com/)). Current public track pages still render, including a SoundCloud/Spotify gate for an Aurelios remix and a Spotify gate for “Zeniah” ([One Kiss remix](https://hypeddit.com/track/mwep3u), [Zeniah](https://hypeddit.com/track/f4heb1)).

**Delivery.** Hypeddit instructs creators to upload a track or exclusive file, so Download Gates are platform-hosted. Link Gates redirect/reveal an external URL ([How to promote music on SoundCloud](https://hypeddit.com/news/how-to-promote-music-on-soundcloud/), [homepage](https://hypeddit.com/)).

**Actions and authentication.**

- Email capture and Spotify follow/save/library actions remain enforceable; Spotify requires its own OAuth.
- SoundCloud follow, repost, like, and comment prompts remain visible, but Hypeddit announced in June 2026 that its SoundCloud API connection is paused and those steps are now voluntary. A fan can download without completing them ([A Change to SoundCloud Download Gates](https://hypeddit.com/news/a-change-to-soundcloud-download-gates/)).
- Historical gates used “Connect with SoundCloud,” meaning SoundCloud OAuth and an authenticated fan account.

**Headless feasibility.** Detecting and recording the campaign URL is easy. Browser-driving an email-only or currently voluntary SoundCloud flow is technically feasible; recovering a hosted file without going through the intended UI is not a supported API workflow. Public projects demonstrate that past DOM/browser flows were scriptable, but they are stale, explicitly framed as bypass tools, and are not authority to integrate ([HypedditSkip-V2](https://github.com/JackSibley/HypedditSkip-V2), [Hypedit_downloader](https://github.com/MalauD/Hypedit_downloader)).

**Risk and recommendation.** Hypeddit's terms prohibit robots, spiders, or automated page copying without prior written permission ([Hypeddit Terms](https://hypeddit.com/terms)). Implement URL recognition and a manual/user-authorized retrieval path first. Do not synthesize fan actions, reuse dummy accounts, or call private endpoints. **Prevalence: uncertain**; no first-party SoundCloud-link metric was found.

### 2. PumpYourSound — active; hosted content; high policy risk

**Current evidence.** Multiple public campaign pages dated 2026 returned live content during this research. They request SoundCloud follows and comments and disclose tracks to be reposted/liked ([Pack Free 2026](https://pumpyoursound.com/f/pys/pack-free-2026-iii/232862), [August 2026 Mega Pack](https://pumpyoursound.com/f/studio-vip-music/mega-pack-update-agosto-2026/231797)). The homepage continues to advertise SoundCloud/Spotify scheduling and free features ([PumpYourSound](https://pumpyoursound.com/)).

**Delivery.** Its terms say uploaded audio is transcoded and stored on PumpYourSound servers, supporting direct hosted delivery. A creator may also place other promotional links, but the reviewed fan-gate pages behave as platform download pages ([Terms & Conditions](https://pumpyoursound.com/article/7-privacy-policy)).

**Actions and authentication.** Current pages expose SoundCloud follow, comment, repost, and like actions; some gates also request a verified email. The terms say certain features require a SoundCloud account and that PumpYourSound extracts permitted SoundCloud account data, implying OAuth/token-based authorization ([current gate](https://pumpyoursound.com/f/pys/fan-gate/21605), [terms](https://pumpyoursound.com/article/7-privacy-policy)).

**Headless feasibility.** The public HTML is easy to identify and parse, but completion needs a SoundCloud session and may trigger email confirmation. A browser worker could execute the UI, but doing so unattended would produce exactly the repetitive account activity both PumpYourSound and SoundCloud restrict.

**Risk and recommendation.** PumpYourSound's own terms prohibit bots/scripts that log in, follow, comment, or otherwise act on a user's behalf in repetitive fashion ([terms](https://pumpyoursound.com/article/7-privacy-policy)). Add detection after Hypeddit, but require human completion or explicit platform permission. **Prevalence: uncertain**.

### 3. GateRush — active; hosted file; OAuth status uncertain

**Current evidence.** Multiple 2026 SoundCloud tracks were observed linking to GateRush, including HAZER's “Dancefloor Disruptor” ([SoundCloud source](https://soundcloud.com/hazeruk/hazer-dancefloor-disruptor), [GateRush](https://gaterush.me/)). The site currently presents Cloudflare browser verification to non-browser fetches, itself a material automation constraint.

**Delivery, actions, and authentication.** GateRush describes hosted download rewards. Its privacy policy says it uses temporary SoundCloud OAuth tokens to perform fan-requested actions and does not retain them after the gate session ([GateRush privacy](https://gaterush.me/privacy)). This supports direct hosted delivery after an OAuth-backed flow, not an unauthenticated redirect contract.

**Headless feasibility and risk.** A full browser with JavaScript, cookies, and a user-authorized SoundCloud session is required. Cloudflare verification may reject datacenter workers, and no first-party notice was found explaining how GateRush's mandatory-action claim interacts with SoundCloud's June 2026 API changes. Recognize links and require manual completion; do not attempt to defeat bot protection. **Prevalence: visibly current but unquantified**.

### 4. Droploud — active; hosted file; explicit OAuth and anti-automation terms

**Current evidence.** Droploud's current product guide says artists upload tracks, configure gates, and deliver free downloads; a current SoundCloud track links to a Droploud campaign ([How it works](https://droploud.com/how-it-works), [live campaign](https://droploud.com/track/d4427d06-38b1-4b59-9d5a-202c998373a7), [SoundCloud source](https://soundcloud.com/vizonn/alive)).

**Delivery, actions, and authentication.** It directly hosts uploaded tracks. Available gates include email, SoundCloud follow/like/repost/comment, Spotify follow/save, and manual social follows. SoundCloud actions use a short-lived OAuth token and can include an automatic follow of Droploud itself ([Gate Terms, version 1.1](https://droploud.com/legal/gate-terms)).

**Headless feasibility and risk.** The flow is technically browser-automatable, but Droploud expressly prohibits bots/scripts, mass completion, DOM tampering, replaying a download URL, or scraping audio outside the gate flow. Implement recognition and user-driven navigation only. **Prevalence uncertain: one current campaign was confirmed**.

### 5. PUSH.fm Reward Links — active; hosted file, secret text, or redirect

**Current evidence.** Damtaro's SoundCloud track “Elevation,” published 2026-07-08, links to a PUSH.fm Reward Link as its “Free HQ Download” ([SoundCloud source](https://soundcloud.com/damtaro/elevation)). PUSH.fm's current help center documents Reward Links ([Reward Link definition](https://support.push.fm/kb/what-is-a-reward-link/)).

**Delivery.** A Reward Link can unlock an uploaded file, reveal a secret message, or reveal/redirect to a secret URL ([Reward types](https://support.push.fm/kb/reward-types/)).

**Actions and authentication.** PUSH.fm supports Spotify/Apple/Deezer actions, YouTube subscribe, SoundCloud follow, social follows/shares, and mailing-list capture. Crucially, its official documentation says SoundCloud, Instagram, YouTube, TikTok, and Twitter actions cannot be mandatory ([Reward Link actions](https://support.push.fm/kb/what-actions-can-i-offer-in-reward-links/)). DSP actions may invoke the DSP's own authorization.

**Headless feasibility and risk.** Non-mandatory SoundCloud actions make compliant user-driven retrieval more plausible than automatic engagement gates, but Cloudflare protects the help/product surface and no public retrieval API was found. Recognize Reward Links and follow the intended browser flow without automating social actions. **Prevalence uncertain**.

### 6. linksr.io — active campaign evidence; implementation contract unclear

**Current evidence.** A live `linksr.io/gate/bombabounce` page identifies itself as a free-download gate, and the corresponding SoundCloud track is titled “BOMBABOUNCE [FREE DL]” ([live gate](https://linksr.io/gate/bombabounce), [SoundCloud source](https://soundcloud.com/bruno-brero/bombabounce)).

**Delivery, actions, and authentication.** The live page asks the fan to connect SoundCloud and says it will automatically follow, repost, like, and comment. The gate therefore requires SoundCloud OAuth. Primary documentation did not establish whether linksr.io stores the reward or redirects to an external host.

**Headless feasibility and risk.** The rendered page is simple enough for Chromium, but automatic multi-action engagement conflicts with SoundCloud's platform-risk constraints and no provider API or clear automation permission was found. Detection/manual navigation only. **Prevalence uncertain: one current campaign was confirmed**.

## Other active or operationally uncertain gate products

### ToneDen — current public surface; hosted file or redirect; operational uncertainty

**Current evidence.** ToneDen's first-party homepage, sign-up links, developer documentation, help center, and a public “Free download on ToneDen” page all returned current pages during research ([ToneDen](https://www.toneden.io/), [public gate](https://www.toneden.io/mizu-official/post/alina-baraz-floating-mi-u-remix), [Social Unlock docs](https://docs-eb.toneden.io/growth-tools/social-unlocks)). This outweighs unsupported third-party claims that the whole service is shut down. It does not prove that every legacy gate or new campaign path works.

**Delivery.** Social Unlocks support:

- `download`: upload a downloadable file;
- `link`: send the fan to a URL;
- `coupon`: reveal text; and
- `stream`: reveal an unlisted YouTube stream.

The official developer model exposes `download_url` for both file and link unlocks ([Social Unlocks API docs](https://developers.toneden.io/docs/social-unlocks), [creation guide](https://docs-eb.toneden.io/growth-tools/social-unlocks/how-to-create-a-social-unlock)).

**Actions and authentication.** Creators can require one or more actions across at most two platforms. Historical/current docs include a SoundCloud follow action and email-list acquisition. ToneDen's API uses reviewed developer apps, OAuth 2.0 Authorization Code flow, and bearer tokens for ToneDen user accounts ([Attachments docs](https://developers.toneden.io/docs/attachments-1), [API getting started](https://developers.toneden.io/docs/getting-started)).

**Headless feasibility.** Campaign URLs are straightforward to recognize. An approved ToneDen API client would be preferable to private endpoint automation, but ToneDen states that support no longer assists with its public API ([API support](https://toneden.gitbook.io/toneden-help-center/toneden-api-support)). Fan-side social completion still depends on each DSP's OAuth and current permissions.

**Risk and recommendation.** Treat as a medium-priority parser/manual workflow. Validate against several fresh links before implementing any automated retrieval. Do not infer health from an old landing page alone. **Prevalence: uncertain**; ToneDen's company-wide user claim is not a SoundCloud gate count.

### Click.DJ — active site/docs; direct file and URL gate; degraded sample behavior

**Current evidence.** The current homepage, FAQ, privacy policy, and terms advertise Download Pages and URL Gates ([Click.DJ](https://click.dj/), [FAQ](https://click.dj/faq), [Privacy](https://click.dj/privacy)). However, the public `click.dj/thefatrat/thefatrat-unity-1` campaign returned HTTP 522 during a direct check on 2026-08-27. That is a warning about campaign reliability, not proof the whole service is dead.

**Delivery.** A Download Page is created by uploading a file; a URL Gate redirects to a pasted URL. Click.DJ's terms confirm that it stores uploaded content on its servers ([homepage](https://click.dj/), [terms](https://click.dj/terms)).

**Actions and authentication.** It advertises Click.DJ plus SoundCloud, Facebook, Twitter, YouTube, Instagram, Spotify, and email follows; Download Pages can request SoundCloud/YouTube repost/share and comments. Its privacy policy explicitly describes SoundCloud OAuth and access used to follow on an authorizing user's behalf ([privacy](https://click.dj/privacy), [FAQ](https://click.dj/faq)).

**Headless feasibility.** URL recognition is easy. There is no public retrieval API in the reviewed first-party material. Browser automation would need social sessions and would be vulnerable to outages and stale integrations.

**Risk and recommendation.** The terms contain broad non-compete/copying language around “Follow to Download,” in addition to normal content obligations ([terms](https://click.dj/terms)). Limit support to recognition and user-driven navigation unless Click.DJ grants written integration permission. **Prevalence: uncertain**.

### Hive download pages — active company; legacy gate surface

**Current evidence.** Hive is active, but its current first-party site focuses on email/SMS audience management and contests. Some legacy `/downloads/download/.../spotlight/` pages still render SoundCloud or Spotify verification steps, while others return Hive's own not-found page ([SoundCloud gate](https://app.hive.co/downloads/download/490540/spotlight/), [Spotify gate](https://app.hive.co/downloads/download/498467/spotlight/), [Hive help](https://faq.hive.co/en)).

**Delivery.** Legacy URLs identify themselves as download pages, but current help documentation does not document file hosting or a supported download-gate API. Do not assume a stable direct-file contract.

**Actions and authentication.** Reviewed legacy pages request email and “Verify with SoundCloud” or “Verify on Spotify.” The current SDK only syncs signups/pageviews, and Hive says it does not currently offer an open API ([Using the Hive SDK](http://faq.hive.co/en/articles/2736106-using-the-hive-sdk)).

**Headless feasibility.** Legacy pages can be rendered in Chromium but are hydration-heavy and campaign-specific. Missing public API support, dead campaigns, and old OAuth integrations make automation fragile.

**Risk and recommendation.** Hive expressly prohibits crawling, scraping, or spidering any page or service data ([Hive Terms](https://www.hive.co/terms-of-use)). Detect legacy links and hand them to a user; do not build an unattended worker. **Prevalence: uncertain**.

### Backstaged Drops — active; hosted file; prevalence uncertain

Backstaged's current Drops product instructs creators to upload a track/sample pack, then select email, SoundCloud follow/like/repost/comment, Instagram follow, or Spotify save/follow gates. Fans only sign into SoundCloud or Spotify when those verification gates are enabled ([Backstaged Drops](https://backstaged.io/drops)). It claims that verified SoundCloud actions still work after the June 2026 API change, but no independent first-party SoundCloud notice confirms that app-specific status.

A headless worker could render the gate, but social completion requires user OAuth and deliberately changes the user's account. Recognize the domain and seek an integration agreement before automation. **SoundCloud-linked prevalence uncertain**.

### Premierely — active; hosted file or redirect; sanctioned creator automation only

Premierely's 2026 product page supports an existing track, uploaded MP3/WAV/FLAC, or a destination link; fans connect SoundCloud in a popup for follow/like/repost/comment verification. It also advertises an MCP tool set for creators to create and manage their own gates, leads, and exports ([Premierely Download Gates](https://premierely.io/product/soundcloud-download-gate), [terms](https://premierely.io/terms-and-conditions)).

That creator-side MCP is not a fan-side reward retrieval API. For preservation, classify the URL and use a user-authorized fan flow unless Premierely grants suitable API access. **SoundCloud-linked prevalence uncertain**.

### Beltergate — active; hosted file; vendor-claimed verification

Beltergate's current 2026 site supports uploaded MP3, WAV, or stems; email capture; and SoundCloud follow/repost/like. Fans may use SoundCloud Connect or manually perform steps and paste a public profile URL. The vendor says it verifies actions through SoundCloud and falls back to an honor system on API failure ([Beltergate](https://beltergate.com/)).

This is technically browser-automatable but lacks a public retrieval API, and the one-click mode requires SoundCloud OAuth. Recognize/manual only pending written permission. **SoundCloud-linked prevalence uncertain**.

### Fangate.eu — active; direct download; prevalence uncertain

Fangate.eu currently advertises unlimited free download gates, email capture, donations, and verified follow/like/repost actions across SoundCloud, Spotify, Apple Music, and other platforms ([Fangate.eu](https://www.fangate.eu/)). Its product page presents downloads as platform-unlocked content rather than a documented external redirect.

No public retrieval API, detailed OAuth documentation, or current SoundCloud campaign sample was established. Recognize the domain but do not automate completion. **SoundCloud-linked prevalence uncertain**.

### Valorizd — active; cloud-hosted gate; prevalence uncertain

Valorizd currently advertises cloud storage (15 MB free, 600 MB Pro, 15 GB Studio), SoundCloud Connect, embedded gate widgets, and actions across SoundCloud, YouTube, Spotify, Instagram, Facebook, Discord, and TikTok ([Valorizd](https://www.valorizd.app/)). Its demo combines SoundCloud follow/like with YouTube engagement.

The site establishes hosted rewards and a current product, but no primary notice resolves whether its SoundCloud one-click actions remain authorized after June 2026. Recognize/manual only. **SoundCloud-linked prevalence uncertain**.

### Show.co — active generic content gate; SoundCloud use appears legacy

Show.co's active Audience Builder product gates destination content behind audience actions and can place the interstitial in front of another URL ([Show.co](https://www.show.co/)). Current first-party material does not establish downloadable-file hosting or detailed SoundCloud OAuth mechanics, and the public SoundCloud examples found were old. Treat it as a generic redirect/interstitial recognizer, not a priority file host. **Current SoundCloud-linked prevalence uncertain**.

## Adjacent active products: recognize, but do not prioritize as file gates

### Feature.fm

Feature.fm is active and offers contests, gates, unlocks, email collection, and action pages. Contest actions include Spotify follow/save, YouTube subscribe, SoundCloud follow, Apple add-to-library, and custom URLs ([Feature.fm contests](https://feature.fm/products/contests), [Create a Contest Link](https://help.feature.fm/articles/5650369121165-Create-a-Contest-Link)). Its documented “post action destination URL or unlock” sends the fan to a configured URL after a DSP action; DSP actions require explicit authentication/permission ([instant-grat workaround](https://help.feature.fm/articles/10686247221517-How-to-Simulate-a-Waterfall-Release-with-an-Instant-Grat-Track-through-Feature-fm), [fan permissions](https://help.feature.fm/articles/35155932413965-Why-Feature-fm-asks-for-Fan-Permissions-to-complete-Pre-Save-Save-Follow-and-Subscribe-Actions)).

The first-party material reviewed does not establish general-purpose downloadable-file hosting. Treat `ffm.to`, `feature.fm`, and customer domains such as `createmusic.fm` as smart/action links that may eventually redirect to an authorized file, not as evidence of an original file. **Prevalence as a SoundCloud free-download gate: uncertain**.

### found.ee

found.ee is active and documents Social Unlock Pages, release pages, and a supported authenticated API ([landing-page collection](http://blog.found.ee/en/collections/10310587-found-ee-landing-pages-marketing-tools), [API reference](https://dev.found.ee/)). Its public API uses user JWTs or approved partner tokens. The reviewed API documentation covers release/pre-save pages but does not expose a public endpoint for retrieving a social-unlock reward.

Treat found.ee URLs as possible action/redirect pages. Seek partner access instead of browser scraping if support becomes necessary. The vendor reports “over 25,000 creators,” but that is not evidence of SoundCloud download-gate prevalence ([found.ee](https://console.found.ee/)). **Prevalence as a SoundCloud free-download gate: uncertain**.

## Dead or legacy platforms

- **FollowGate:** `followgate.com` did not resolve in DNS during a direct check on 2026-08-27, and no current first-party product/help pages were found. Secondary listings are insufficient to call it active. Classify as **inactive/dead unless a live campaign proves otherwise**.
- **DemoDrop:** its own domain says “DemoDrop is gone… RIP DemoDrop, 2013–2021” ([DemoDrop](https://demodrop.com/track/313547)). **Dead.**
- **The Artist Union:** the service announced shutdown for 2020-08-01; its old domain is no longer a functioning music gate. The surviving shutdown email is preserved by ArchiveTeam, not a current platform source ([ArchiveTeam record](https://wiki.archiveteam.org/index.php/The_Artist_Union), [archiver source](https://github.com/ArchiveTeam/theartistunion-grab)). **Dead.**
- **ArtistEngine, Stereoload, TuneBoost/Tuneboost, Tunebula, and The Husk:** no current first-party product documentation or live, verifiable campaigns were found. Do not implement from old “best gates” lists. **Unverified legacy/dead.**

## Not download gates

- **Bandcamp, iTunes/Apple Music, Beatport, and other stores** sell, stream, or allow artist-configured free/name-your-price releases. They do not gate a file behind social actions. SoundCloud itself describes iTunes and Bandcamp as destinations for an external Buy link ([SoundCloud playlist help](https://help.soundcloud.com/hc/en-us/articles/46312437920411-Playlist-Issues-Troubleshooting)).
- **Dropbox, Google Drive, OneDrive, MediaFire, and direct CDN URLs** host files. A gate may redirect to them, but they are not gates.
- **SoundCloud's native Download file button** is a direct, uploader-authorized original download, not a third-party gate.
- **Smart-link-only pages** that merely list Spotify/Apple/YouTube/Beatport destinations are not gates unless an action must unlock a file or secret destination.

## Recommended implementation policy

1. Classify known gate domains and preserve the outbound campaign URL plus visible metadata; never label the reward as the SoundCloud original without hashing/provenance evidence.
2. First support **user-authorized navigation** for Hypeddit, PumpYourSound, GateRush, Droploud, PUSH.fm Reward Links, and linksr.io. Add recognizers for the prevalence-uncertain and legacy products without promising automatic retrieval.
3. Permit a worker to follow ordinary HTTP redirects and download a reward only after the provider's intended flow has produced an explicit file response in a user-authorized session.
4. Do not automate follows, likes, reposts, comments, email verification, CAPTCHA, OAuth consent, or “skip/bypass” endpoints.
5. Ask providers for an API/partner agreement before unattended retrieval. found.ee has an explicit partner-token model and Premierely exposes creator-side MCP tools, but neither is a published fan-side preservation API.
6. Record final URL, response headers, filename, MIME type, size, hash, retrieval time, provider, and whether the result was hosted or redirected. Keep it separate from SoundCloud's native-original provenance.

## Evidence limits

- Public landing pages prove that a route rendered on the research date, not that new campaign creation, every OAuth action, or final file delivery succeeded.
- Search-engine indexing overrepresents old campaigns. Dates in campaign titles establish current creator activity only when the live page itself renders.
- Open-source bypass scripts prove historical implementation feasibility, not permission, current compatibility, or platform prevalence.
- No first-party cross-platform usage dataset was found. The ranking therefore reflects product fit, current first-party evidence, and safe engineering value—not measured market share.
