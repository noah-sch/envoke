# envoke

App de bureau de chat IA multi-comptes : moteurs, API locale HTTP/SSE, interface web et CLI. Plan : PLAN.md.

## Commandes

- `nvm use` (Node 24 requis : Node exécute les `.ts` directement, aucune étape de build)
- `pnpm install`
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm format`
- `pnpm cli <commande>` (chat, connections, profiles, link, unlink)
- `pnpm serve` (API + interface sur 127.0.0.1:4317 ; ouvrir l'adresse du champ `open`)
- `pnpm web:build` (construit l'interface dans `packages/web/dist`, servie par `pnpm serve`)
- `pnpm dev` (moteur + Vite sur :5173 avec rechargement ; ouvrir l'adresse affichée)
- `ENVOKE_DATA_DIR=<dossier>` pour isoler les données pendant les essais

## Conventions

- Interface : `packages/web` (React + Vite), design system envoke corail clair (tokens dans
  `src/styles.css`, Manrope / Inter / JetBrains Mono auto-hébergées). Elle n'importe du cœur que
  `@envoke/core/types`, qui n'importe rien.
- TypeScript strict, ESM, syntaxe effaçable uniquement (`erasableSyntaxOnly`) : pas d'enum, pas de
  propriétés de paramètre, imports relatifs avec l'extension `.ts`.
- Les types des SDK ne sortent pas de leur adaptateur (`packages/core/src/providers`, `acp/`).
- Aucun nom de modèle dans le code : ils viennent de la configuration.
- Les tests n'appellent jamais le réseau : faux serveurs HTTP (`test/helpers.ts`), faux agent ACP
  (`test/fixtures/fake-agent.ts`), faux Claude Code (`test/fixtures/fake-claude.ts`).
- Avant de coder contre une API externe (Anthropic, OpenAI, ACP), lire sa doc actuelle.

## Sécurité (non négociable)

- Aucune commande ni écriture de fichier sans la porte de permissions.
- Le serveur n'écoute que sur 127.0.0.1, exige le jeton, vérifie Host et Origin.
- Secrets uniquement dans le trousseau ; jamais dans la config, la base, les logs ou l'environnement
  des commandes lancées par l'agent.
- Jamais de login Claude.ai ni de jeton de session Claude : l'abonnement Claude est exclu du produit.
  Seule exception, façon Orca : le terminal intégré lance le Claude Code de l'utilisateur, qui s'y
  connecte lui-même ; envoke ne lit, ne stocke ni ne relaie aucun identifiant Claude. La vue chat
  passe par les hooks officiels (`--settings`) ; le jeton de hook d'un processus ne sert qu'à poster
  les événements de sa session.
- Les connexions par abonnement restent bloquées sauf si `policy.subscriptionLogins` les autorise.

## commit

Convention de commits (maintenue par /commit).
- Style : Conventional Commits — langue : fr
- Scopes (chemin → scope) :
  - `packages/core/**` → `core`
  - `packages/server/**` → `server`
  - `packages/cli/**` → `cli`
  - `packages/web/**` → `web`
  - `PLAN.md`, `CLAUDE.md` → `docs`
  - config racine (`package.json`, `pnpm-*`, `tsconfig*`, lint, prettier, vitest, `scripts/**`) → `chore` (sans scope)
