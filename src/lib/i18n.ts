/**
 * User-facing strings, one table per guild-selectable locale.
 *
 * Discord has no per-user message language for bot output — a button
 * label or a channel post is seen identically by everyone in the guild
 * — so the unit of localisation is the guild. `/star-comms set-language`
 * writes `guilds.locale`; every handler resolves its table from that
 * column via `stringsFor(locale)`.
 *
 * The `Strings` interface is the contract: every locale must implement
 * every key, so adding a string means adding it four times and the
 * compiler enforces it. Pirate variants are real locales, not a filter
 * over en/da — they read better hand-written.
 *
 * Discord limits to respect when editing:
 *   - slash-command description        ≤ 100 chars
 *   - button label                     ≤ 80 chars
 *   - select option label/description  ≤ 100 chars
 *   - modal title                      ≤ 45 chars, text-input label ≤ 45
 */

import { LOCALES, type Locale } from './config.js';

export interface Strings {
  /** Slash-command descriptions, registered per guild in its language. */
  cmd: {
    root: string;
    watchChannel: string;
    setLanguage: string;
    register: string;
    registerCallsignOption(min: number, max: number): string;
    unregister: string;
    callsign: string;
    status: string;
  };
  common: {
    guildOnly: string;
    needManageServer(subcommand: string): string;
  };
  watchChannel: {
    noneYet: string;
    current(channelId: string): string;
    placeholder: string;
    intro(guildName: string, currentNote: string): string;
    cancelled: string;
    set(channelId: string): string;
    timeout: string;
  };
  setLanguage: {
    intro(guildName: string, currentLabel: string): string;
    placeholder: string;
    set(label: string): string;
    /** Appended when the chosen locale has no cue audio installed. */
    noCues(fallbackLabel: string): string;
    cancelled: string;
    timeout: string;
  };
  callsign: {
    registered(callsign: string): string;
    noneRegistered: string;
    removed(previous: string): string;
    noneToReport: string;
    current(callsign: string): string;
    errTooShort(min: number): string;
    errTooLong(max: number): string;
    errPattern: string;
    errTaken(callsign: string): string;
  };
  status: {
    title: string;
  };
  panel: {
    title(ownerMention: string): string;
    locked: string;
    open: string;
    noLimit: string;
    limit(n: number): string;
    hailsOn(callsign: string): string;
    hailsOff: string;
    callsignNote: string;
    btnRename: string;
    btnLock: string;
    btnUnlock: string;
    btnLimit: string;
    btnKick: string;
    btnAllowHails: string;
    btnDisableHails: string;
    btnHail: string;
  };
  panelHandlers: {
    stale: string;
    notOwner: string;
    renameTitle: string;
    renameLabel(min: number, max: number): string;
    invalidName: string;
    callsignConflict: string;
    renameRateLimited: string;
    renamed(name: string): string;
    limitTitle: string;
    limitLabel: string;
    limitInvalid(raw: string): string;
    limitRemoved: string;
    limitSet(n: number): string;
    kickPlaceholder: string;
    kickIntro: string;
    kickSelf: string;
    kickNotMember: string;
    kickNotInChannel(userId: string): string;
    kickNoPermission(userId: string): string;
    kicked(userId: string): string;
    needCallsignFirst: string;
    renameLimitDetail: string;
    renameManualDetail: string;
    hailsEnabledRenameFailed(detail: string): string;
    enableHailsFirst: string;
    noOtherVessels: string;
    hailPickPlaceholder(maxTargets: number): string;
    hailPickIntro: string;
    noTargets: string;
    noneAvailable: string;
    opening(count: number): string;
    hailOpen(silenceSeconds: number): string;
    hailError(reason: string): string;
  };
  hail: {
    btnEnd: string;
    active: string;
    btnAccept: string;
    btnDecline: string;
    incoming: string;
    onlyOwnerResponds: string;
    notRinging: string;
  };
  vessel: {
    cannotMoveNotice: string;
    transferred(oldOwnerUserId: string, successorMention: string): string;
  };
}

/** Selector metadata — label is written in the language itself. */
export interface LocaleMeta {
  label: string;
  emoji: string;
  description: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { label: 'English', emoji: '🇬🇧', description: 'Standard English' },
  da: { label: 'Dansk', emoji: '🇩🇰', description: 'Almindeligt dansk' },
  'en-pirate': { label: 'English (Pirate)', emoji: '🏴‍☠️', description: 'Arr! Talk like a pirate' },
  'da-pirate': { label: 'Dansk (Sørøver)', emoji: '🏴‍☠️', description: 'Arr! Snak som en sørøver' },
};

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const en: Strings = {
  cmd: {
    root: 'Star Comms — cooperative-play voice bridge.',
    watchChannel: 'Admin: pick the voice channel Star Comms watches as the join-to-create trigger.',
    setLanguage: 'Admin: choose the language Star Comms uses in this server.',
    register: 'Register or replace your callsign in this server.',
    registerCallsignOption: (min, max) => `Your ship name (${min}–${max} characters).`,
    unregister: 'Remove your callsign. Drops your vessels from the hail directory too.',
    callsign: 'Report your current callsign.',
    status: 'Report the fleet state for this server.',
  },
  common: {
    guildOnly: 'This command must be used in a server.',
    needManageServer: (sub) => `You need the **Manage Server** permission to run \`/star-comms ${sub}\`.`,
  },
  watchChannel: {
    noneYet: 'No trigger channel configured yet.',
    current: (id) => `Currently: <#${id}>.`,
    placeholder: 'Pick the join-to-create voice channel',
    intro: (guild, note) =>
      `**Star Comms — watch channel for ${guild}**\n${note}\n\n` +
      `Which voice channel should Star Comms watch as the join-to-create trigger? ` +
      `When a member joins it, a new vessel channel is created and the member is moved into it.`,
    cancelled: 'Nothing selected — cancelled.',
    set: (id) =>
      `Star Comms is now watching <#${id}> as the join-to-create trigger. ` +
      `When someone joins it, they will be moved into a fresh vessel channel of their own.`,
    timeout: 'Cancelled — no channel selected within 60 seconds. Re-run `/star-comms watch-channel` when ready.',
  },
  setLanguage: {
    intro: (guild, current) =>
      `**Star Comms — language for ${guild}**\nCurrently: ${current}.\n\n` +
      `Pick the language Star Comms uses for buttons, messages and voice cues in this server.`,
    placeholder: 'Pick a language',
    set: (label) => `Language set to **${label}**. Existing control panels update the next time they are used.`,
    noCues: (fallback) => ` Voice cues for this language are not installed — ${fallback} cues play until they are.`,
    cancelled: 'Nothing selected — cancelled.',
    timeout: 'Cancelled — no language selected within 60 seconds.',
  },
  callsign: {
    registered: (cs) => `Callsign registered: **${cs}**. Enable it on a vessel with the **Allow hails** button.`,
    noneRegistered: 'You do not have a callsign registered in this server.',
    removed: (prev) => `Callsign **${prev}** removed. Any vessels you owned that were in the hail directory have been dropped from it.`,
    noneToReport: 'You have no callsign registered in this server. Set one with `/star-comms register <callsign>`.',
    current: (cs) => `Your callsign in this server is **${cs}**.`,
    errTooShort: (min) => `A callsign must be at least ${min} characters.`,
    errTooLong: (max) => `A callsign must be at most ${max} characters.`,
    errPattern: 'A callsign may contain letters, numbers, spaces, hyphens, underscores and apostrophes only, and must start and end with a letter or number.',
    errTaken: (cs) => `The callsign "${cs}" is already registered by another member in this server.`,
  },
  status: {
    title: '**Star Comms fleet status**',
  },
  panel: {
    title: (owner) => `🛰️ **Vessel controls** — ${owner}`,
    locked: '🔒  Locked — only invited members can join',
    open: '🔓  Open — anyone with view access can join',
    noLimit: '👥  No user limit',
    limit: (n) => `👥  Limit: ${n}`,
    hailsOn: (cs) => `📡  Hails on — 🛰️ **${cs}**`,
    hailsOff: '📡  Hails off',
    callsignNote: '\n_Register a callsign with `/star-comms register` to enable **Allow hails** and the hail directory._',
    btnRename: 'Rename',
    btnLock: 'Lock',
    btnUnlock: 'Unlock',
    btnLimit: 'Limit',
    btnKick: 'Kick',
    btnAllowHails: 'Allow hails',
    btnDisableHails: 'Disable hails',
    btnHail: 'Hail',
  },
  panelHandlers: {
    stale: 'This panel is stale — the vessel is no longer tracked.',
    notOwner: 'Only the channel owner can use these controls.',
    renameTitle: 'Rename your channel',
    renameLabel: (min, max) => `New name (${min}–${max} chars)`,
    invalidName: 'Invalid name.',
    callsignConflict: 'That callsign is taken.',
    renameRateLimited: 'Discord\'s rename limit for this channel is reached. Try again in ~10 minutes.',
    renamed: (name) => `Renamed to **${name}**.`,
    limitTitle: 'User limit',
    limitLabel: 'Max users (0 = no limit, max 99)',
    limitInvalid: (raw) => `Not a valid limit: **${raw}**. Enter an integer between 0 (no limit) and 99.`,
    limitRemoved: 'User limit removed.',
    limitSet: (n) => `User limit set to ${n}.`,
    kickPlaceholder: 'Pick a member to disconnect',
    kickIntro: 'Pick a member to disconnect from your channel. The bot disconnects them from voice — they can rejoin if the channel is unlocked.',
    kickSelf: 'You cannot kick yourself.',
    kickNotMember: 'That member is not in this server.',
    kickNotInChannel: (id) => `<@${id}> is not in this channel.`,
    kickNoPermission: (id) => `The bot cannot move <@${id}> — they may hold a role higher than the controller.`,
    kicked: (id) => `Disconnected <@${id}> from the channel.`,
    needCallsignFirst: 'Register a callsign with `/star-comms register` first — the button label reflects this after a refresh.',
    renameLimitDetail: 'Discord\'s rename limit for this channel is reached — try again in ~10 minutes.',
    renameManualDetail: 'Use the **Rename** button to set the name manually.',
    hailsEnabledRenameFailed: (detail) => `Hails enabled — the channel name could not be updated automatically. ${detail}`,
    enableHailsFirst: 'Enable hails on your own channel first — the button is disabled until then.',
    noOtherVessels: 'No other vessels have hails enabled in this server yet.',
    hailPickPlaceholder: (n) => (n > 1 ? `Pick up to ${n} vessels to hail` : 'Pick a vessel to hail'),
    hailPickIntro: '🛰️ Pick vessels to hail. Ready cue on your side, Attention cue on theirs.',
    noTargets: 'No targets picked.',
    noneAvailable: 'None of the picked vessels are still available.',
    opening: (n) => `🛰️ Opening hail to ${n} vessel(s)…`,
    hailOpen: (s) => `Hail open. Speak now. Silence for ${s}s auto-closes.`,
    hailError: (reason) => {
      switch (reason) {
        case 'no_relays': return 'Not enough relay bots are free right now. Try again in a minute.';
        case 'not_in_guild': return 'Not enough relay bots are in this server. Ask the server owner to invite the missing relays.';
        case 'no_targets': return 'No targets were selected.';
        case 'target_gone': return 'The target vessel disappeared before the hail could open.';
        case 'already_hailing': return 'Your channel is already in an active hail. End it before starting a new one.';
        case 'target_busy': return 'The chosen target is already in another hail. Try again once it has ended.';
        case 'declined': return 'The target declined the hail.';
        case 'timeout': return 'The target did not answer within the ring window.';
        case 'all_declined': return 'Every target declined or did not answer.';
        default: return `Hail could not open: ${reason}`;
      }
    },
  },
  hail: {
    btnEnd: 'End hail',
    active: '🛰️ **Hail active.**',
    btnAccept: 'Accept',
    btnDecline: 'Decline',
    incoming: '🛰️ **Incoming hail.** Only the vessel owner can respond.',
    onlyOwnerResponds: 'Only the vessel owner can respond to this hail.',
    notRinging: 'This hail is no longer waiting for a response.',
  },
  vessel: {
    cannotMoveNotice:
      '\n_Discord blocks the bot from moving you (most often because you are the server owner). ' +
      'Join this channel manually to activate it._',
    transferred: (old, succ) => `⚓ <@${old}> left. Ownership passed to ${succ}. Hails disabled.`,
  },
};

// ---------------------------------------------------------------------------
// Dansk
// ---------------------------------------------------------------------------

const da: Strings = {
  cmd: {
    root: 'Star Comms — stemmebro til samarbejdsspil.',
    watchChannel: 'Admin: vælg den stemmekanal Star Comms overvåger som join-to-create-udløser.',
    setLanguage: 'Admin: vælg det sprog Star Comms bruger på denne server.',
    register: 'Registrér eller udskift dit kaldesignal på denne server.',
    registerCallsignOption: (min, max) => `Dit skibsnavn (${min}–${max} tegn).`,
    unregister: 'Fjern dit kaldesignal. Fjerner også dine fartøjer fra kaldeoversigten.',
    callsign: 'Vis dit nuværende kaldesignal.',
    status: 'Vis flådens tilstand på denne server.',
  },
  common: {
    guildOnly: 'Denne kommando kan kun bruges på en server.',
    needManageServer: (sub) => `Du skal have rettigheden **Administrér server** for at køre \`/star-comms ${sub}\`.`,
  },
  watchChannel: {
    noneYet: 'Ingen udløserkanal er sat op endnu.',
    current: (id) => `Nuværende: <#${id}>.`,
    placeholder: 'Vælg join-to-create-stemmekanalen',
    intro: (guild, note) =>
      `**Star Comms — overvåg kanal for ${guild}**\n${note}\n\n` +
      `Hvilken stemmekanal skal Star Comms overvåge som join-to-create-udløser? ` +
      `Når et medlem joiner den, oprettes en ny fartøjskanal, og medlemmet flyttes derind.`,
    cancelled: 'Intet valgt — afbrudt.',
    set: (id) =>
      `Star Comms overvåger nu <#${id}> som join-to-create-udløser. ` +
      `Når nogen joiner den, flyttes de ind i deres egen nye fartøjskanal.`,
    timeout: 'Afbrudt — ingen kanal valgt inden for 60 sekunder. Kør `/star-comms watch-channel` igen, når du er klar.',
  },
  setLanguage: {
    intro: (guild, current) =>
      `**Star Comms — sprog for ${guild}**\nNuværende: ${current}.\n\n` +
      `Vælg det sprog Star Comms skal bruge til knapper, beskeder og stemmesignaler på denne server.`,
    placeholder: 'Vælg et sprog',
    set: (label) => `Sproget er nu **${label}**. Eksisterende kontrolpaneler opdateres, næste gang de bruges.`,
    noCues: (fallback) => ` Stemmesignaler på dette sprog er ikke installeret — der bruges ${fallback}, indtil de er.`,
    cancelled: 'Intet valgt — afbrudt.',
    timeout: 'Afbrudt — intet sprog valgt inden for 60 sekunder.',
  },
  callsign: {
    registered: (cs) => `Kaldesignal registreret: **${cs}**. Slå det til på et fartøj med knappen **Tillad kald**.`,
    noneRegistered: 'Du har ikke registreret et kaldesignal på denne server.',
    removed: (prev) => `Kaldesignalet **${prev}** er fjernet. Fartøjer du ejede, som stod i kaldeoversigten, er fjernet fra den.`,
    noneToReport: 'Du har intet kaldesignal på denne server. Sæt et med `/star-comms register <kaldesignal>`.',
    current: (cs) => `Dit kaldesignal på denne server er **${cs}**.`,
    errTooShort: (min) => `Et kaldesignal skal være mindst ${min} tegn.`,
    errTooLong: (max) => `Et kaldesignal må højst være ${max} tegn.`,
    errPattern: 'Et kaldesignal må kun indeholde bogstaver, tal, mellemrum, bindestreger, understreger og apostroffer, og skal begynde og slutte med et bogstav eller tal.',
    errTaken: (cs) => `Kaldesignalet "${cs}" er allerede registreret af et andet medlem på denne server.`,
  },
  status: {
    title: '**Star Comms flådestatus**',
  },
  panel: {
    title: (owner) => `🛰️ **Fartøjskontrol** — ${owner}`,
    locked: '🔒  Låst — kun inviterede medlemmer kan joine',
    open: '🔓  Åben — alle med adgang kan joine',
    noLimit: '👥  Ingen brugergrænse',
    limit: (n) => `👥  Grænse: ${n}`,
    hailsOn: (cs) => `📡  Kald slået til — 🛰️ **${cs}**`,
    hailsOff: '📡  Kald slået fra',
    callsignNote: '\n_Registrér et kaldesignal med `/star-comms register` for at aktivere **Tillad kald** og kaldeoversigten._',
    btnRename: 'Omdøb',
    btnLock: 'Lås',
    btnUnlock: 'Lås op',
    btnLimit: 'Grænse',
    btnKick: 'Smid ud',
    btnAllowHails: 'Tillad kald',
    btnDisableHails: 'Slå kald fra',
    btnHail: 'Kald',
  },
  panelHandlers: {
    stale: 'Dette panel er forældet — fartøjet spores ikke længere.',
    notOwner: 'Kun kanalens ejer kan bruge disse knapper.',
    renameTitle: 'Omdøb din kanal',
    renameLabel: (min, max) => `Nyt navn (${min}–${max} tegn)`,
    invalidName: 'Ugyldigt navn.',
    callsignConflict: 'Det kaldesignal er optaget.',
    renameRateLimited: 'Discords grænse for omdøbning af denne kanal er nået. Prøv igen om ca. 10 minutter.',
    renamed: (name) => `Omdøbt til **${name}**.`,
    limitTitle: 'Brugergrænse',
    limitLabel: 'Maks. brugere (0 = ingen grænse, maks. 99)',
    limitInvalid: (raw) => `Ugyldig grænse: **${raw}**. Skriv et heltal mellem 0 (ingen grænse) og 99.`,
    limitRemoved: 'Brugergrænsen er fjernet.',
    limitSet: (n) => `Brugergrænsen er sat til ${n}.`,
    kickPlaceholder: 'Vælg et medlem at afbryde',
    kickIntro: 'Vælg et medlem, der skal afbrydes fra din kanal. Botten afbryder dem fra stemmechatten — de kan joine igen, hvis kanalen ikke er låst.',
    kickSelf: 'Du kan ikke smide dig selv ud.',
    kickNotMember: 'Det medlem er ikke på denne server.',
    kickNotInChannel: (id) => `<@${id}> er ikke i denne kanal.`,
    kickNoPermission: (id) => `Botten kan ikke flytte <@${id}> — de har muligvis en rolle over controlleren.`,
    kicked: (id) => `<@${id}> er afbrudt fra kanalen.`,
    needCallsignFirst: 'Registrér først et kaldesignal med `/star-comms register` — knappen afspejler det efter en opdatering.',
    renameLimitDetail: 'Discords grænse for omdøbning af denne kanal er nået — prøv igen om ca. 10 minutter.',
    renameManualDetail: 'Brug knappen **Omdøb** for at sætte navnet manuelt.',
    hailsEnabledRenameFailed: (detail) => `Kald er slået til — kanalnavnet kunne ikke opdateres automatisk. ${detail}`,
    enableHailsFirst: 'Slå først kald til på din egen kanal — knappen er deaktiveret indtil da.',
    noOtherVessels: 'Ingen andre fartøjer på denne server har kald slået til endnu.',
    hailPickPlaceholder: (n) => (n > 1 ? `Vælg op til ${n} fartøjer at kalde` : 'Vælg et fartøj at kalde'),
    hailPickIntro: '🛰️ Vælg fartøjer at kalde. Klar-signal hos dig, Giv agt-signal hos dem.',
    noTargets: 'Ingen mål valgt.',
    noneAvailable: 'Ingen af de valgte fartøjer er stadig tilgængelige.',
    opening: (n) => `🛰️ Åbner kald til ${n} fartøj(er)…`,
    hailOpen: (s) => `Kaldet er åbent. Tal nu. ${s} sekunders stilhed lukker det automatisk.`,
    hailError: (reason) => {
      switch (reason) {
        case 'no_relays': return 'Der er ikke nok frie relæ-bots lige nu. Prøv igen om et minut.';
        case 'not_in_guild': return 'Der er ikke nok relæ-bots på denne server. Bed serverejeren om at invitere de manglende relæer.';
        case 'no_targets': return 'Ingen mål blev valgt.';
        case 'target_gone': return 'Målfartøjet forsvandt, før kaldet kunne åbnes.';
        case 'already_hailing': return 'Din kanal er allerede i et aktivt kald. Afslut det, før du starter et nyt.';
        case 'target_busy': return 'Det valgte mål er allerede i et andet kald. Prøv igen, når det er afsluttet.';
        case 'declined': return 'Målet afviste kaldet.';
        case 'timeout': return 'Målet svarede ikke inden for ringetiden.';
        case 'all_declined': return 'Alle mål afviste eller svarede ikke.';
        default: return `Kaldet kunne ikke åbnes: ${reason}`;
      }
    },
  },
  hail: {
    btnEnd: 'Afslut kald',
    active: '🛰️ **Kald aktivt.**',
    btnAccept: 'Acceptér',
    btnDecline: 'Afvis',
    incoming: '🛰️ **Indgående kald.** Kun fartøjets ejer kan svare.',
    onlyOwnerResponds: 'Kun fartøjets ejer kan svare på dette kald.',
    notRinging: 'Dette kald venter ikke længere på svar.',
  },
  vessel: {
    cannotMoveNotice:
      '\n_Discord tillader ikke botten at flytte dig (oftest fordi du er serverejer). ' +
      'Join denne kanal manuelt for at aktivere den._',
    transferred: (old, succ) => `⚓ <@${old}> forlod kanalen. Ejerskabet er overdraget til ${succ}. Kald slået fra.`,
  },
};

// ---------------------------------------------------------------------------
// English (Pirate) — arr.
// ---------------------------------------------------------------------------

const enPirate: Strings = {
  cmd: {
    root: 'Star Comms — a voice bridge fer crews sailin\' together, arr.',
    watchChannel: 'Cap\'n only: pick the voice channel Star Comms watches as the join-to-create trigger.',
    setLanguage: 'Cap\'n only: choose the tongue Star Comms speaks aboard this ship.',
    register: 'Register or swap yer callsign aboard this ship.',
    registerCallsignOption: (min, max) => `Yer vessel\'s name (${min}–${max} characters).`,
    unregister: 'Strike yer callsign from the log. Yer vessels leave the hail directory too.',
    callsign: 'Report yer current callsign.',
    status: 'Report the state o\' the fleet aboard this ship.',
  },
  common: {
    guildOnly: 'This order only works aboard a ship (server), matey.',
    needManageServer: (sub) => `Ye need the **Manage Server** permission to run \`/star-comms ${sub}\`, landlubber.`,
  },
  watchChannel: {
    noneYet: 'No trigger channel be set yet.',
    current: (id) => `Currently: <#${id}>.`,
    placeholder: 'Pick the join-to-create voice channel',
    intro: (guild, note) =>
      `**Star Comms — watch channel fer ${guild}**\n${note}\n\n` +
      `Which voice channel should Star Comms keep a weather eye on as the join-to-create trigger? ` +
      `When a crewmate boards it, a fresh vessel channel be spawned and they be hauled aboard it.`,
    cancelled: 'Nothin\' picked — belay that.',
    set: (id) =>
      `Star Comms now keeps watch on <#${id}> as the join-to-create trigger. ` +
      `When a crewmate boards it, they be hauled into a fresh vessel o\' their own.`,
    timeout: 'Belayed — no channel picked within 60 seconds. Run `/star-comms watch-channel` again when ye be ready.',
  },
  setLanguage: {
    intro: (guild, current) =>
      `**Star Comms — tongue fer ${guild}**\nCurrently: ${current}.\n\n` +
      `Pick the tongue Star Comms speaks fer buttons, messages and voice cues aboard this ship.`,
    placeholder: 'Pick a tongue',
    set: (label) => `Tongue set to **${label}**, arr! Control panels already posted update next time they be used.`,
    noCues: (fallback) => ` Voice cues in this tongue ain\'t installed yet — ${fallback} cues play until they be.`,
    cancelled: 'Nothin\' picked — belay that.',
    timeout: 'Belayed — no tongue picked within 60 seconds.',
  },
  callsign: {
    registered: (cs) => `Callsign entered in the log: **${cs}**. Hoist it on a vessel with the **Allow hails** button.`,
    noneRegistered: 'Ye have no callsign in the log aboard this ship.',
    removed: (prev) => `Callsign **${prev}** struck from the log. Any vessel ye owned in the hail directory be dropped from it.`,
    noneToReport: 'Ye have no callsign aboard this ship. Set one with `/star-comms register <callsign>`.',
    current: (cs) => `Yer callsign aboard this ship be **${cs}**.`,
    errTooShort: (min) => `A callsign must be at least ${min} characters, ye scallywag.`,
    errTooLong: (max) => `A callsign must be at most ${max} characters — trim yer sails.`,
    errPattern: 'A callsign may carry letters, numbers, spaces, hyphens, underscores and apostrophes only, and must start and end with a letter or number.',
    errTaken: (cs) => `The callsign "${cs}" already flies on another crewmate\'s mast aboard this ship.`,
  },
  status: {
    title: '**Star Comms fleet status, arr**',
  },
  panel: {
    title: (owner) => `🛰️ **Vessel helm** — Cap\'n ${owner}`,
    locked: '🔒  Battened down — only invited crew can board',
    open: '🔓  Open deck — any soul with view access can board',
    noLimit: '👥  No crew limit',
    limit: (n) => `👥  Crew limit: ${n}`,
    hailsOn: (cs) => `📡  Hails on — 🛰️ **${cs}**`,
    hailsOff: '📡  Hails off',
    callsignNote: '\n_Enter a callsign in the log with `/star-comms register` to unlock **Allow hails** and the hail directory._',
    btnRename: 'Rename',
    btnLock: 'Batten down',
    btnUnlock: 'Open deck',
    btnLimit: 'Crew limit',
    btnKick: 'Walk the plank',
    btnAllowHails: 'Allow hails',
    btnDisableHails: 'Disable hails',
    btnHail: 'Hail',
  },
  panelHandlers: {
    stale: 'This panel be stale — the vessel be no longer on our charts.',
    notOwner: 'Only the cap\'n o\' this vessel can touch the helm.',
    renameTitle: 'Rename yer vessel',
    renameLabel: (min, max) => `New name (${min}–${max} chars)`,
    invalidName: 'That be no proper name.',
    callsignConflict: 'That callsign already flies elsewhere.',
    renameRateLimited: 'Discord\'s rename limit fer this channel be reached. Try again in ~10 minutes.',
    renamed: (name) => `Rechristened **${name}**.`,
    limitTitle: 'Crew limit',
    limitLabel: 'Max crew (0 = no limit, max 99)',
    limitInvalid: (raw) => `That be no valid limit: **${raw}**. Enter a whole number between 0 (no limit) and 99.`,
    limitRemoved: 'Crew limit lifted.',
    limitSet: (n) => `Crew limit set to ${n}.`,
    kickPlaceholder: 'Pick a scallywag to send overboard',
    kickIntro: 'Pick a crewmate to send off yer vessel. The bot disconnects them from voice — they can climb back aboard if the deck be open.',
    kickSelf: 'Ye cannot make yerself walk the plank.',
    kickNotMember: 'That soul ain\'t aboard this ship.',
    kickNotInChannel: (id) => `<@${id}> ain\'t on this vessel.`,
    kickNoPermission: (id) => `The bot cannot move <@${id}> — they may outrank the controller.`,
    kicked: (id) => `<@${id}> walked the plank. Overboard!`,
    needCallsignFirst: 'Enter a callsign with `/star-comms register` first — the button shows it after a refresh.',
    renameLimitDetail: 'Discord\'s rename limit fer this channel be reached — try again in ~10 minutes.',
    renameManualDetail: 'Use the **Rename** button to christen it by hand.',
    hailsEnabledRenameFailed: (detail) => `Hails enabled — but the channel name could not be changed on its own. ${detail}`,
    enableHailsFirst: 'Enable hails on yer own vessel first — the button stays dead until then.',
    noOtherVessels: 'No other vessels aboard this ship have hails enabled yet. Lonely seas.',
    hailPickPlaceholder: (n) => (n > 1 ? `Pick up to ${n} vessels to hail` : 'Pick a vessel to hail'),
    hailPickIntro: '🛰️ Pick vessels to hail. Ready cue on yer deck, Attention cue on theirs.',
    noTargets: 'No targets picked.',
    noneAvailable: 'None o\' the picked vessels be still afloat.',
    opening: (n) => `🛰️ Hailin\' ${n} vessel(s)…`,
    hailOpen: (s) => `Hail open. Speak now, ye sea dog. ${s}s o\' silence closes it.`,
    hailError: (reason) => {
      switch (reason) {
        case 'no_relays': return 'Not enough relay bots be free right now. Try again in a minute.';
        case 'not_in_guild': return 'Not enough relay bots be aboard this ship. Ask the ship\'s owner to invite the missin\' relays.';
        case 'no_targets': return 'No targets were picked.';
        case 'target_gone': return 'The target vessel sank beneath the waves before the hail could open.';
        case 'already_hailing': return 'Yer vessel be already in a hail. End it before startin\' another.';
        case 'target_busy': return 'The chosen target be already in another hail. Try again once it be done.';
        case 'declined': return 'The target refused yer hail. Scurvy dogs.';
        case 'timeout': return 'The target never answered within the ring window.';
        case 'all_declined': return 'Every target refused or never answered.';
        default: return `Hail could not open: ${reason}`;
      }
    },
  },
  hail: {
    btnEnd: 'End hail',
    active: '🛰️ **Hail open, arr.**',
    btnAccept: 'Aye!',
    btnDecline: 'Nay!',
    incoming: '🛰️ **Incoming hail!** Only the vessel\'s cap\'n can answer.',
    onlyOwnerResponds: 'Only the vessel\'s cap\'n can answer this hail.',
    notRinging: 'This hail be no longer waitin\' fer an answer.',
  },
  vessel: {
    cannotMoveNotice:
      '\n_Discord won\'t let the bot haul ye aboard (most often because ye own the ship). ' +
      'Board this channel yerself to raise the colours._',
    transferred: (old, succ) => `⚓ <@${old}> abandoned ship. ${succ} be the new cap\'n. Hails disabled.`,
  },
};

// ---------------------------------------------------------------------------
// Dansk (Sørøver) — arr, for søren.
// ---------------------------------------------------------------------------

const daPirate: Strings = {
  cmd: {
    root: 'Star Comms — stemmebro for besætninger, der sejler sammen, arr.',
    watchChannel: 'Kun kaptajner: vælg den stemmekanal Star Comms holder udkig med som join-to-create-udløser.',
    setLanguage: 'Kun kaptajner: vælg det tungemål Star Comms taler om bord på dette skib.',
    register: 'Skriv dit kaldesignal i logbogen, eller udskift det.',
    registerCallsignOption: (min, max) => `Dit fartøjs navn (${min}–${max} tegn).`,
    unregister: 'Stryg dit kaldesignal fra logbogen. Dine fartøjer forlader også kaldeoversigten.',
    callsign: 'Vis dit nuværende kaldesignal.',
    status: 'Vis flådens tilstand om bord på dette skib.',
  },
  common: {
    guildOnly: 'Den ordre virker kun om bord på et skib (server), makker.',
    needManageServer: (sub) => `Du skal have rettigheden **Administrér server** for at give ordren \`/star-comms ${sub}\`, landkrabbe.`,
  },
  watchChannel: {
    noneYet: 'Der er endnu ingen udløserkanal.',
    current: (id) => `Nuværende: <#${id}>.`,
    placeholder: 'Vælg join-to-create-stemmekanalen',
    intro: (guild, note) =>
      `**Star Comms — udkig for ${guild}**\n${note}\n\n` +
      `Hvilken stemmekanal skal Star Comms holde udkig med som join-to-create-udløser? ` +
      `Når en skibskammerat går om bord, søsættes et nyt fartøj, og kammeraten hales derover.`,
    cancelled: 'Intet valgt — ordren er trukket tilbage.',
    set: (id) =>
      `Star Comms holder nu udkig med <#${id}> som join-to-create-udløser. ` +
      `Når nogen går om bord, hales de over i deres eget nye fartøj.`,
    timeout: 'Trukket tilbage — ingen kanal valgt inden for 60 sekunder. Giv ordren `/star-comms watch-channel` igen, når du er klar.',
  },
  setLanguage: {
    intro: (guild, current) =>
      `**Star Comms — tungemål for ${guild}**\nNuværende: ${current}.\n\n` +
      `Vælg det tungemål Star Comms taler i knapper, beskeder og stemmesignaler om bord på dette skib.`,
    placeholder: 'Vælg et tungemål',
    set: (label) => `Tungemålet er nu **${label}**, arr! Kontrolpaneler, der allerede er slået op, opdateres, næste gang de bruges.`,
    noCues: (fallback) => ` Stemmesignaler på dette tungemål er ikke lastet endnu — der bruges ${fallback}, indtil de er.`,
    cancelled: 'Intet valgt — ordren er trukket tilbage.',
    timeout: 'Trukket tilbage — intet tungemål valgt inden for 60 sekunder.',
  },
  callsign: {
    registered: (cs) => `Kaldesignalet **${cs}** er skrevet i logbogen. Hejs det på et fartøj med knappen **Tillad kald**.`,
    noneRegistered: 'Du har intet kaldesignal i logbogen om bord på dette skib.',
    removed: (prev) => `Kaldesignalet **${prev}** er strøget fra logbogen. Fartøjer du ejede i kaldeoversigten er smidt over bord fra den.`,
    noneToReport: 'Du har intet kaldesignal om bord på dette skib. Sæt et med `/star-comms register <kaldesignal>`.',
    current: (cs) => `Dit kaldesignal om bord på dette skib er **${cs}**.`,
    errTooShort: (min) => `Et kaldesignal skal være mindst ${min} tegn, din skurk.`,
    errTooLong: (max) => `Et kaldesignal må højst være ${max} tegn — rev sejlene.`,
    errPattern: 'Et kaldesignal må kun bære bogstaver, tal, mellemrum, bindestreger, understreger og apostroffer, og skal begynde og slutte med et bogstav eller tal.',
    errTaken: (cs) => `Kaldesignalet "${cs}" vajer allerede fra en anden skibskammerats mast om bord på dette skib.`,
  },
  status: {
    title: '**Star Comms flådestatus, arr**',
  },
  panel: {
    title: (owner) => `🛰️ **Fartøjets ror** — kaptajn ${owner}`,
    locked: '🔒  Skalket — kun inviteret besætning kan gå om bord',
    open: '🔓  Åbent dæk — alle med adgang kan gå om bord',
    noLimit: '👥  Ingen besætningsgrænse',
    limit: (n) => `👥  Besætningsgrænse: ${n}`,
    hailsOn: (cs) => `📡  Kald slået til — 🛰️ **${cs}**`,
    hailsOff: '📡  Kald slået fra',
    callsignNote: '\n_Skriv et kaldesignal i logbogen med `/star-comms register` for at låse **Tillad kald** og kaldeoversigten op._',
    btnRename: 'Omdøb',
    btnLock: 'Skalk lugerne',
    btnUnlock: 'Åbn dækket',
    btnLimit: 'Besætning',
    btnKick: 'Planken ud',
    btnAllowHails: 'Tillad kald',
    btnDisableHails: 'Slå kald fra',
    btnHail: 'Kald',
  },
  panelHandlers: {
    stale: 'Dette panel er forældet — fartøjet er ikke længere på vores søkort.',
    notOwner: 'Kun fartøjets kaptajn må røre roret.',
    renameTitle: 'Omdøb dit fartøj',
    renameLabel: (min, max) => `Nyt navn (${min}–${max} tegn)`,
    invalidName: 'Det er ikke et ordentligt navn.',
    callsignConflict: 'Det kaldesignal vajer allerede et andet sted.',
    renameRateLimited: 'Discords grænse for omdøbning af denne kanal er nået. Prøv igen om ca. 10 minutter.',
    renamed: (name) => `Omdøbt til **${name}**.`,
    limitTitle: 'Besætningsgrænse',
    limitLabel: 'Maks. besætning (0 = ingen grænse, maks. 99)',
    limitInvalid: (raw) => `Det er ingen gyldig grænse: **${raw}**. Skriv et helt tal mellem 0 (ingen grænse) og 99.`,
    limitRemoved: 'Besætningsgrænsen er ophævet.',
    limitSet: (n) => `Besætningsgrænsen er sat til ${n}.`,
    kickPlaceholder: 'Vælg en skurk til planken',
    kickIntro: 'Vælg en skibskammerat, der skal sendes fra borde. Botten afbryder dem fra stemmechatten — de kan kravle om bord igen, hvis dækket er åbent.',
    kickSelf: 'Du kan ikke sende dig selv ud på planken.',
    kickNotMember: 'Den sjæl er ikke om bord på dette skib.',
    kickNotInChannel: (id) => `<@${id}> er ikke på dette fartøj.`,
    kickNoPermission: (id) => `Botten kan ikke flytte <@${id}> — de har muligvis højere rang end controlleren.`,
    kicked: (id) => `<@${id}> gik planken ud. Over bord!`,
    needCallsignFirst: 'Skriv først et kaldesignal i logbogen med `/star-comms register` — knappen viser det efter en opdatering.',
    renameLimitDetail: 'Discords grænse for omdøbning af denne kanal er nået — prøv igen om ca. 10 minutter.',
    renameManualDetail: 'Brug knappen **Omdøb** for at døbe det med egen hånd.',
    hailsEnabledRenameFailed: (detail) => `Kald er slået til — men kanalnavnet kunne ikke ændres af sig selv. ${detail}`,
    enableHailsFirst: 'Slå først kald til på dit eget fartøj — knappen er død indtil da.',
    noOtherVessels: 'Ingen andre fartøjer om bord på dette skib har kald slået til endnu. Ensomme have.',
    hailPickPlaceholder: (n) => (n > 1 ? `Vælg op til ${n} fartøjer at kalde` : 'Vælg et fartøj at kalde'),
    hailPickIntro: '🛰️ Vælg fartøjer at kalde. Klar-signal på dit dæk, Giv agt-signal på deres.',
    noTargets: 'Ingen mål valgt.',
    noneAvailable: 'Ingen af de valgte fartøjer er stadig på havet.',
    opening: (n) => `🛰️ Kalder ${n} fartøj(er)…`,
    hailOpen: (s) => `Kaldet er åbent. Tal nu, din søulk. ${s} sekunders stilhed lukker det.`,
    hailError: (reason) => {
      switch (reason) {
        case 'no_relays': return 'Der er ikke nok frie relæ-bots lige nu. Prøv igen om et minut.';
        case 'not_in_guild': return 'Der er ikke nok relæ-bots om bord på dette skib. Bed skibets ejer om at invitere de manglende relæer.';
        case 'no_targets': return 'Ingen mål blev valgt.';
        case 'target_gone': return 'Målfartøjet sank i bølgerne, før kaldet kunne åbnes.';
        case 'already_hailing': return 'Dit fartøj er allerede i et kald. Afslut det, før du starter et nyt.';
        case 'target_busy': return 'Det valgte mål er allerede i et andet kald. Prøv igen, når det er slut.';
        case 'declined': return 'Målet afviste dit kald. Skørbugsramte hunde.';
        case 'timeout': return 'Målet svarede aldrig inden for ringetiden.';
        case 'all_declined': return 'Alle mål afviste eller svarede aldrig.';
        default: return `Kaldet kunne ikke åbnes: ${reason}`;
      }
    },
  },
  hail: {
    btnEnd: 'Afslut kald',
    active: '🛰️ **Kaldet er åbent, arr.**',
    btnAccept: 'Javel!',
    btnDecline: 'Aldrig!',
    incoming: '🛰️ **Indgående kald!** Kun fartøjets kaptajn kan svare.',
    onlyOwnerResponds: 'Kun fartøjets kaptajn kan svare på dette kald.',
    notRinging: 'Dette kald venter ikke længere på svar.',
  },
  vessel: {
    cannotMoveNotice:
      '\n_Discord lader ikke botten hale dig om bord (oftest fordi du ejer skibet). ' +
      'Gå selv om bord i denne kanal for at hejse flaget._',
    transferred: (old, succ) => `⚓ <@${old}> forlod skibet. ${succ} er ny kaptajn. Kald slået fra.`,
  },
};

const TABLES: Record<Locale, Strings> = { en, da, 'en-pirate': enPirate, 'da-pirate': daPirate };

/** Resolve the string table for a locale. Unknown values fall back to English. */
export function stringsFor(locale: string): Strings {
  return (TABLES as Record<string, Strings>)[locale] ?? en;
}

export { LOCALES };
export type { Locale };
