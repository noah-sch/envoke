# envoke — plan des moteurs

Application de bureau commerciale : une interface de chat (hors périmètre ici) qui se branche sur des
comptes IA ou des providers. Ce dépôt livre **les moteurs**, une **API locale HTTP/SSE** que l'interface
consomme, et une **CLI** de test. Aucune UI web.

## Décisions

| Sujet        | Choix                                                                            | Raison                                                                        |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Distribution | App de bureau, un utilisateur par installation, moteurs sur la machine du client | Comme Orca : les agents et le terminal sont locaux                            |
| Runtime      | Node.js 24 LTS, TypeScript 6 strict, ESM                                         | Node 24 exécute le `.ts` directement (type stripping) : aucune étape de build |
| Dépôt        | Monorepo pnpm : `core`, `server`, `cli`                                          | Le cœur ignore le transport                                                   |
| Serveur      | Hono sur `127.0.0.1`, SSE                                                        | Léger, testable sans réseau (`app.request`)                                   |
| Stockage     | `node:sqlite` intégré à Node                                                     | Aucun module natif à compiler ni à embarquer                                  |
| Secrets      | Trousseau du système (`@napi-rs/keyring`)                                        | Jamais en clair sur disque, jamais dans la base                               |
| Tests        | Vitest, aucun appel réseau réel (faux serveurs HTTP, faux agent ACP)             | Reproductible                                                                 |

## Deux moteurs

```
UI ──HTTP/SSE──▶ server ──▶ AgentBackend
                            ├─ NativeBackend   notre boucle + nos outils + notre porte de permissions
                            │    ├─ anthropic          Messages API, clé API
                            │    ├─ openai-responses   Responses API, clé API OU compte ChatGPT (Sign in with ChatGPT)
                            │    └─ openai-compat      Chat Completions : Mistral, OpenRouter, Gemini API, Ollama…
                            └─ AcpBackend      boucle et outils de l'agent de l'éditeur (Agent Client Protocol)
                                 └─ n'importe quel agent du registre ACP : Claude Agent, Codex, Gemini CLI,
                                    GitHub Copilot, OpenCode, Cursor, Goose, Mistral Vibe…
```

- **Connexion** (`connection`) : _comment_ on accède à un service — clé API, compte ChatGPT, agent ACP.
- **Profil** (`profile`) : une connexion + un modèle + ses réglages. Une session de chat utilise un profil.
- L'UI et le serveur ne parlent qu'à `AgentBackend` et ne voient que des `AgentEvent`.

## Règle commerciale (politique de connexions)

| Connexion                                                            | Par défaut | Pourquoi                                                                                               |
| -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| Clé API (Anthropic, OpenAI, compatibles)                             | Autorisée  | Usage facturé au client par le fournisseur                                                             |
| Agent ACP lancé avec une clé API injectée                            | Autorisé   | Ex. Claude Agent avec `ANTHROPIC_API_KEY`                                                              |
| Compte ChatGPT (Sign in with ChatGPT)                                | **Bloqué** | App payante : formulaire d'intérêt OpenAI requis                                                       |
| Agent ACP avec login d'abonnement (Claude Pro/Max, ChatGPT, Google…) | **Bloqué** | Anthropic interdit l'abonnement Claude dans un produit tiers ; les autres sont à valider juridiquement |
| Claude Code de l'utilisateur, dans un terminal intégré               | Autorisé   | Comme Orca : envoke lance le binaire officiel, l'utilisateur se connecte dans Claude Code              |

`policy.subscriptionLogins` liste les exceptions autorisées (vide par défaut). Un agent ACP dont la clé n'est
pas liée et dont le login d'abonnement n'est pas autorisé ne démarre pas.

Le terminal Claude Code n'est pas une connexion d'abonnement d'envoke : c'est l'utilisateur qui utilise
Claude Code, dans une fenêtre d'envoke. envoke ne lit, ne stocke ni ne relaie aucun identifiant Claude ;
la connexion se fait dans Claude Code (`/login`), par la page d'Anthropic. Anthropic n'a rien publié qui
vise précisément ce cas : notre lecture (usage ordinaire de Claude Code) reste à confirmer juridiquement.

## Arborescence

```
packages/
  core/src/
    types.ts             types internes (aucun type de SDK n'en sort)
    config.ts            connexions, profils, politique ; fichier JSON dans le dossier de données
    credentials.ts       trousseau système + mémoire (tests)
    providers/           anthropic.ts  openai-responses.ts  openai-compat.ts
    auth/chatgpt.ts      OAuth PKCE loopback, enregistrement dynamique, refresh sérialisé, révocation
    agent/               loop.ts  permissions.ts  system-prompt.ts
    tools/               bash.ts  read-file.ts  write-file.ts  edit-file.ts  paths.ts  output.ts
    acp/                 registry.ts (registre + installation)  backend.ts (AgentBackend ACP)
    backends/native.ts   AgentBackend natif
    connections.ts       catalogue : statut, lier, délier
    store.ts             SessionStore (interface + mémoire)
  server/src/            app.ts (routes, sécurité)  db.ts (SQLite + migrations)  main.ts
  cli/src/               main.ts (chat, connections, link, unlink)
```

## Phases

Chaque phase se termine par `pnpm typecheck && pnpm lint && pnpm test` au vert.

### Phase 0 — Socle

Monorepo pnpm, TS strict partagé, ESLint, Prettier, Vitest, `.nvmrc` (24), `.gitignore`, `CLAUDE.md`.
**Accepté si** les quatre commandes passent sur le dépôt neuf.

### Phase 1 — Types, configuration, secrets

Types internes, chargement de la config (défauts embarqués + fichier utilisateur), politique, trousseau.
**Accepté si** une config invalide donne une erreur lisible, et aucun secret n'est écrit dans le fichier de config.

### Phase 2 — Boucle native, outils, permissions

Boucle (50 itérations max), outils `bash`/`read_file`/`write_file`/`edit_file`, porte de permissions
(une fois / toujours par préfixe de commande pour la session / refuser).
**Accepté si** (tests avec faux provider) : refus remonté au modèle, `sleep 300` tué au délai, sortie tronquée
à 30 000 caractères, `../../etc/passwd` refusé, « toujours » ne couvre pas `git status; rm -rf x`,
aucune variable `*_API_KEY` dans l'environnement des commandes.

### Phase 3 — Providers à clé API

`anthropic` (streaming, outils, réflexion relue telle quelle, cache de prompt, fallback de refus),
`openai-responses` (`store:false`, raisonnement chiffré relu), `openai-compat` (fragments d'appels d'outils).
**Accepté si** une suite de conformité unique passe contre les trois adaptateurs via de faux serveurs HTTP.

### Phase 4 — Compte ChatGPT (Sign in with ChatGPT)

OAuth PKCE sur `127.0.0.1:1455`, `client_id=dynamic_agent_client` puis client émis réutilisé,
`ext_agent_host_id` stable, vérification de l'ID token (JWKS, issuer, audience, nonce), scope
`chatgpt.tokens.use.direct` exigé, refresh sérialisé (jeton tournant), révocation, liste des modèles.
Bloqué par la politique par défaut.
**Accepté si** (faux serveur d'autorisation) : flux complet, `state` faux rejeté, refus utilisateur géré,
deux refresh simultanés n'en font qu'un.

### Phase 5 — Moteur ACP

Registre ACP (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`), installation unique
(paquet npm dans le dossier de données, ou binaire vérifié par SHA-256), un processus par agent partagé
entre sessions, démarré au premier usage et arrêté après inactivité, `session/new` / `session/load`,
streaming des `session/update`, permissions relayées, annulation, authentification (`agent` / `terminal`)
soumise à la politique, clés injectées par variables d'environnement.
**Accepté si** (faux agent ACP) : texte et outils streamés, permission refusée bloque l'outil, annulation,
reprise de session après redémarrage du processus.

### Phase 6 — Serveur local et persistance

Routes ci-dessous, jeton aléatoire obligatoire, contrôle `Host` et `Origin`, `127.0.0.1` seulement,
SQLite (sessions, messages, journal des commandes) avec migrations numérotées.
**Accepté si** : 401 sans jeton, 403 avec Origin étranger, flux SSE complet avec faux provider,
historique conservé après redémarrage, aucune clé dans la base.

### Phase 7 — CLI

`envoke chat`, `envoke connections`, `envoke link <id>`, `envoke unlink <id>`.
**Accepté si** on peut lier une clé, discuter en streaming, valider une commande, couper avec Ctrl+C.

### Phase 8 — Interface de chat

`packages/web` : React + Vite, design system envoke **corail clair** (canvas « Nuances de vert pastel »,
version corail claire) : fond `#F5F4F2`, surfaces blanches, corail `#FF6363`, texte corail `#B3383A`,
Manrope / Inter / JetBrains Mono auto-hébergées (l'app marche hors ligne). Servie par le serveur local
sur `/`, sans jeton ; le jeton arrive dans le fragment d'URL (`/#token=…`) et reste dans la fenêtre.

Écrans : historique groupé par date (recherche, renommer, supprimer), nouvelle conversation (dossier de
travail, suggestions), fil en streaming (Markdown sans HTML brut, blocs de code copiables, réflexion
repliable, cartes d'outils avec validation Autoriser une fois / Toujours / Refuser), mode de réponse
Rapide / Équilibré / Approfondi (effort du modèle, moteur natif), Régénérer (moteur natif), Stop,
choix du profil, page Connexions (clés API, compte ChatGPT, agents). Écran étroit : historique en tiroir.

**Accepté si** : build Vite sans erreur, tests du parseur SSE, du réducteur de tours et du regroupement
par date au vert, et parcours réel serveur + faux fournisseur : interface servie avec CSP stricte,
streaming, permission accordée puis commande exécutée, Régénérer, titre automatique.

### Phase 9 — Claude Code dans un terminal (façon Orca)

Pour utiliser son abonnement Claude (Pro, Max…) sans qu'envoke touche au compte : envoke lance le
Claude Code installé par l'utilisateur dans un pseudo-terminal (`node-pty`) et l'affiche avec xterm.js.

- Session `kind: "terminal"` dans l'historique, à côté des chats ; on l'ouvre depuis le menu de profil
  d'une nouvelle conversation (« Claude Code ») ou depuis Connexions. La première demande est facultative.
- Le processus démarre quand le premier écran s'y attache, à sa taille. Il continue de tourner quand on
  ferme l'onglet ; un écran qui revient reçoit l'état exact (copie serveur avec `@xterm/headless` +
  `addon-serialize`), puis la suite.
- L'id de session envoke sert d'id Claude Code (`--session-id`) : Reprendre relance `--resume <id>` ; une
  conversation jamais enregistrée repart sous le même id.
- Environnement sans secrets (`safeEnv`) et sans les marqueurs d'une session Claude Code parente
  (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`…), sinon Claude Code n'enregistre rien.
- `node-pty` 1.2.0-beta.18 : la 1.1.0 publie son `spawn-helper` macOS sans droit d'exécution. Binaires
  précompilés fournis (macOS, Linux, Windows) : aucun script d'installation (`allowBuilds: false`).
- xterm (339 Ko) est chargé seulement à l'ouverture d'un terminal.

**Accepté si** : tests avec un faux Claude Code (arguments, secrets absents, saisie, écran rendu au retour,
arrêt, reprise, repli sans conversation, suppression) et parcours réel avec le vrai Claude Code de la
machine : démarrage connecté au compte, arrêt, Reprendre, aucun processus laissé à l'arrêt du serveur.

### Phase 10 — Claude Code affiché en chat

Le terminal reste la source : Claude Code tourne toujours en interactif, avec le compte de
l'utilisateur. envoke en montre une vue chat (bulles, Markdown, cartes d'outils, demandes d'accord),
alimentée par les **hooks officiels** de Claude Code, comme le fait Orca, sans lire son écran ni le
format interne de ses fichiers de conversation.

- Au lancement, `--settings` ajoute des hooks HTTP vers `POST /api/hooks/:id` : `UserPromptSubmit`
  (message envoyé), `MessageDisplay` (texte au fil de l'eau), `PreToolUse` / `PostToolUse(Failure)`
  (outils), `PermissionRequest` (question gardée ouverte jusqu'à la réponse dans envoke), `Stop`,
  `StopFailure`, `Notification`. `SessionStart` refuse les hooks HTTP : une commande `curl` silencieuse
  fait la même requête. Vérifié : ces hooks s'ajoutent à ceux de l'utilisateur, sans les remplacer.
- Chaque processus reçoit son propre jeton de hook (`ENVOKE_HOOK_TOKEN`), qui ne permet que de poster
  les événements de sa session ; ce n'est pas le jeton de l'API.
- Les événements sont rangés dans l'historique de la session : la conversation revient après un
  rechargement ou un redémarrage d'envoke.
- Envoyer = coller le message dans Claude Code (collage entre crochets, pour garder les retours à la
  ligne) puis Entrée ; Stop = Échap. « Toujours » répond avec la suggestion de Claude Code, limitée à
  la session.
- Bouton Chat / Terminal : le terminal reste là pour `/login`, la confiance du dossier, les menus et
  les questions que le chat ne sait pas montrer ; envoke le signale quand Claude Code les attend.
- Pas de réflexion du modèle dans la vue chat : aucun hook ne la transmet.

**Accepté si** : tests du pont (traduction des hooks, permission, reprise d'une vue en cours, jeton),
du réducteur de la vue, et parcours HTTP réel avec un faux Claude Code qui exécute ses hooks ; parcours
réel avec le vrai Claude Code : un message, une commande affichée en carte, la réponse, l'historique
retrouvé après rechargement.

## API locale

| Route                                          | Rôle                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/connections`                         | Connexions, statut (liée ou non), autorisation par la politique                                            |
| `POST /api/connections/:id/link`               | Clé API (`{apiKey}`), lance l'OAuth ChatGPT (`{authorizeUrl}`), ou authentifie un agent ACP (`{methodId}`) |
| `DELETE /api/connections/:id`                  | Délie (supprime le secret, révoque le jeton ChatGPT)                                                       |
| `GET /api/connections/:id/models`              | Modèles disponibles (compte ChatGPT)                                                                       |
| `GET /api/profiles`                            | Profils utilisables                                                                                        |
| `GET /api/sessions` · `POST /api/sessions`     | Liste · crée (`{profileId, cwd}`)                                                                          |
| `GET /api/sessions/:id` · `PATCH` · `DELETE`   | Historique · renomme · supprime                                                                            |
| `POST /api/sessions/:id/messages`              | Envoie un message (`{text, effort?}`) ; réponse = flux SSE d'`AgentEvent`                                  |
| `POST /api/sessions/:id/regenerate`            | Rejoue le dernier message après avoir retiré sa réponse (moteur natif) ; flux SSE                          |
| `GET /api/info`                                | Version et dossier personnel (dossier de travail par défaut)                                               |
| `POST /api/permissions/:requestId`             | Décision `allow_once` / `allow_always` / `deny`                                                            |
| `POST /api/sessions/:id/abort`                 | Interrompt le tour et tue la commande en cours                                                             |
| `GET /api/connections/:id`                     | Statut d'une connexion + état de la connexion ChatGPT en cours (`login`)                                   |
| `GET /api/claude-code`                         | Claude Code installé ? (`{installed, path}`)                                                               |
| `POST /api/terminals`                          | Ouvre une session terminal Claude Code (`{cwd, prompt?}`)                                                  |
| `GET /api/terminals/:id/stream?cols&rows`      | Flux SSE de `TerminalEvent` : `snapshot`, puis `data`, `start`, `exit` ; démarre une session neuve         |
| `POST /api/terminals/:id/input` · `resize`     | Frappes (`{data}`) · taille (`{cols, rows}`)                                                               |
| `POST /api/terminals/:id/stop` · `resume`      | Arrête Claude Code · le relance sur la même conversation (`{cols, rows}`)                                  |
| `GET /api/terminals/:id/chat`                  | Vue chat (SSE) : instantané `history`, puis `prompt`, `AgentEvent`, `notice`, `process`                    |
| `POST /api/terminals/:id/prompt` · `interrupt` | Envoie un message à Claude Code (`{text}`) · l'interrompt (Échap)                                          |
| `POST /api/hooks/:id`                          | Hooks de Claude Code, avec le jeton de hook du processus (pas celui de l'API)                              |

### Contrat pour l'interface

- **Démarrage** : l'app lance `node packages/server/src/main.ts` ; la première ligne de stdout est
  `{"ready":true,"url":"http://127.0.0.1:4317","token":"…"}`. `ENVOKE_PORT`, `ENVOKE_TOKEN` et
  `ENVOKE_ORIGINS` (origines autorisées, séparées par des virgules) se règlent par l'environnement.
- **Chaque requête** porte `Authorization: Bearer <token>`. Sans jeton : 401. Origin ou Host étranger : 403.
- **Erreurs** : `{"error":{"code","message"}}`. `code` sert à traduire (`auth_required`, `policy`,
  `usage_limit`, `rate_limit`, `network`…), `message` est un texte français prêt à afficher.
- **Flux SSE** de `POST /api/sessions/:id/messages` : un événement par `AgentEvent`
  (`packages/core/src/types.ts`) — `text_delta`, `thinking_delta`, `tool_start`, `permission_request`,
  `tool_end`, `usage`, `turn_done`, `error`. Le flux se ferme après `turn_done` ou `error`.
  Fermer la requête annule le tour.
- **Permission** : à la réception de `permission_request`, afficher `title` et répondre par
  `POST /api/permissions/:requestId` pendant que le flux reste ouvert.
- **Compte ChatGPT** (si la politique l'autorise) : `POST /api/connections/chatgpt/link` avec `{}` renvoie
  `authorizeUrl` à ouvrir dans le navigateur système, puis interroger `GET /api/connections/chatgpt`
  jusqu'à `login.state` = `linked` ou `error`.

## État (26 novembre 2026)

Phases 0 à 10 livrées. `pnpm typecheck`, `pnpm lint`, `pnpm test` (97 tests) et `pnpm web:build` passent.

Vérifié en réel : CLI, serveur (401, 403, SSE, refus de la politique, aucune écoute hors 127.0.0.1),
trousseau macOS, installation et `initialize` du vrai Claude Agent depuis le registre ACP, terminal
Claude Code avec le vrai binaire et le compte de la machine, vue chat avec un vrai message.

Non vérifié en réel (pas d'appel facturé, pas de compte) : réponses des API Anthropic et OpenAI (couvertes
par de faux serveurs reproduisant leurs flux), connexion ChatGPT réelle, agents Codex, Gemini CLI et Copilot.

## Efficacité

- Processus ACP longs, partagés, démarrés à la demande, arrêtés après 10 min d'inactivité.
- Reprise via `session/load` plutôt que renvoi de l'historique.
- Streaming de bout en bout, sans tampon intermédiaire.
- Préfixe stable (instructions + outils) pour le cache de prompt ; cache automatique Anthropic.
- Un seul refresh de jeton ChatGPT en vol à la fois.
- Aucun build : Node 24 exécute les sources.

## Hors périmètre v1

Packaging (Electron/Tauri), Windows natif (l'outil `bash` suppose un shell POSIX ;
le trousseau Windows limite la taille des secrets), facturation liée Anthropic (bêta, exige un backend),
agents ACP distants, compaction du contexte, client MCP.

## Avant lancement commercial

1. Formulaire d'intérêt OpenAI pour « Use your ChatGPT plan » dans une app payante.
2. Vérifier les conditions de chaque agent ACP proposé avec un login d'abonnement.
3. Ne jamais proposer de login Claude.ai : l'abonnement Claude reste exclu du produit. Faire valider
   juridiquement le terminal Claude Code (envoke y lance le binaire officiel, sans toucher au compte).
4. Tester chaque agent ACP du catalogue avec une vraie clé : identifiant de méthode d'auth par clé
   (`gemini-api-key` pour Gemini CLI est à confirmer ; Codex n'en a pas de configuré), et vérifier qu'il
   n'utilise pas un login personnel présent sur la machine (`configDirEnv` isole Claude Agent et Codex).
5. Embarquer `npm` avec l'app packagée : les agents distribués par npm s'installent avec lui.
6. App packagée : `node-pty` doit être construit pour le runtime embarqué, et le PATH d'une app lancée
   depuis le Finder ne contient pas celui du shell (la recherche de `claude` couvre `~/.local/bin` et
   `~/.claude/local`).
