# Kopje instance

A [Kopje](https://github.com/shuymn/kopje/tree/main/packages/kopje) instance: a Mastodon-compatible ActivityPub
server for one person or a small group, running as one Cloudflare Worker with one Durable Object on your own Cloudflare
account.

This repository holds only the instance's configuration. The server is the
[`kopje`](https://www.npmjs.com/package/kopje) npm package, pinned in `package.json`; `src/index.ts` re-exports it.
`wrangler.jsonc` is the same for every install: your domain, your Access applications and your admin account are kept in
the instance's Store and set in the browser, through the `/setup` wizard.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shuymn/kopje/tree/main/deploy)

## Before you deploy

Read [setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md), "Before you start". You
need the Workers Paid plan, a zone on the account for the instance's domain, and a Zero Trust organization. Kopje
cannot run on a `workers.dev` address.

## Deploy with the button

The button copies this directory into a new repository on your GitHub or GitLab account, connects it to Workers
Builds, and deploys it. On its form:

- **Resources.** It creates the Worker, the Store's Durable Object namespace, the Queue (`my-kopje-queue`) and the R2
  bucket (`my-kopje-media`). Change their names if your account already uses them. The Queue's dead-letter queue keeps
  the messages that exhaust their retries. The form does not rename it: it is created as `my-kopje-queue-dlq` whatever
  you call the Queue. For a second Kopje in the same account, give it its own: in the new repository's
  `wrangler.jsonc`, change `dead_letter_queue` to a new name, create that queue with
  `npx wrangler queues create <name>`, and change the two rate-limit `namespace_id`s too. The rate limits, Images and
  the static assets need no resource of their own.
- **Secrets.** It asks for the two secrets in `.dev.vars.example`:
  - `SETUP_TOKEN`: at least 32 random characters, for example from `openssl rand -base64 33`. It opens the `/setup`
    wizard. Remove it once setup is finished.
  - `USER_KEK`: a long random value, for example from `openssl rand -base64 33`. It wraps the private keys of local
    accounts. Keep a copy somewhere safe: keys wrapped with it cannot be read with any other value.
- **Build and deploy commands.** Leave the build command empty and the deploy command `npm run deploy`
  (`wrangler deploy`). `wrangler deploy` copies the static assets from the installed package first
  (`scripts/assets.mjs`).

Then attach your domain to the Worker (Settings, Domains & Routes, as a custom domain or a route on your zone), open
`https://example.com/setup` (your domain), and follow
[setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md).

## Settings after setup

Set these on the Worker in the dashboard (Settings, Variables and Secrets) or with `npx wrangler secret put <NAME>`.
`wrangler.jsonc` keeps variables set in the dashboard across deploys (`keep_vars`). The table lists the common ones;
[setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md), "Before you start", documents the
rest (the Images limits, `REMOTE_MEDIA_CACHE_BYTES` and `MEDIA_CACHE_RETENTION_DAYS`).

Kopje's log events are kept in Workers Logs for 7 days; invocation logs and traces are off:
[observability.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/observability.md) says where to
read them, what they cost, what they record and how to change the `observability` block.

| Name                                                             | Kind     | What for                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`                                                    | secret   | Remove it after setup                                                                                                                                                      |
| `USER_KEK`                                                       | secret   | Set before the admin is created; change it only as [setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md), "Rotating the KEK", says            |
| `VAPID_JWK`                                                      | secret   | Optional, turns on Web Push: an EC P-256 private key as a JWK (below). Never replace it once clients have subscribed                                                       |
| `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET` | variable | The daily encrypted backup. See [backup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/backup.md) for these and the optional `BACKUP_*` settings        |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`         | secret   | The backup storage's credentials                                                                                                                                           |
| `IMAGES_MONTHLY_TRANSFORMS`                                      | variable | Optional: raise it if you buy more Images transformations ([setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md), "Before you start", step 6) |
| `MAINTENANCE`                                                    | variable | `off` (the default), `readonly` or `full`. Used for a rollback ([upgrade.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/upgrade.md))                    |

A key for `VAPID_JWK` can be made with Node.js:

```sh
node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>crypto.subtle.exportKey('jwk',k.privateKey)).then(j=>console.log(JSON.stringify(j)))"
```

## The admin CLI

After `npm ci`, `npm run admin -- <command>` runs the `kopje-admin` CLI of the installed `kopje` version, for example
`npm run admin -- health`. See
[setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md#running-the-admin-cli) for the
service token and the variables it needs. Accounts besides the admin's are made by invitation
(`npm run admin -- invitation add <email> <username>`) together with an Access policy for the person:
[setup.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/setup.md#adding-accounts).

## Video and audio (optional)

Kopje takes image uploads only. Video and audio need the media processor: a container with a pinned ffmpeg build,
which Cloudflare runs next to the Worker and bills by use under the Workers Paid plan's container allowance. Its
Dockerfile ships in the `kopje` package (`node_modules/kopje/container`), so the image always matches the installed
version, and every deploy builds it: Workers Builds (the button's) needs no Docker on your machine, while
`npx wrangler deploy` from your own machine needs Docker running there (GitHub's runners have it).

In this release uploads stay image-only. The processor already serves the media rebuild, which makes the stills of
video rows with it (`kopje-admin media-rebuild`, activated by its own probe of `still@standard-1`), and once it is
bound and `MEDIA_UPLOAD_MONTHLY_JOBS` is positive the cron probes the profile uploads will use, `normalize@standard-4`
([media-processor.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/media-processor.md)). The two
activations are separate. To add it:

1. Export `MediaProcessor` from `src/index.ts`. The template's file already does; an instance made from an earlier
   template has `export { default, Store } from "kopje";`, and `wrangler deploy` then fails with "Your Worker depends
   on the following Durable Objects, which are not exported in your entrypoint file: MediaProcessor". Change it to:

   ```ts
   export { default, MediaProcessor, Store } from "kopje";
   ```

2. In `wrangler.jsonc`, add the binding to `durable_objects.bindings`, the migration after `v1` in `"migrations"`, and
   the `"containers"` entry. The template's `wrangler.jsonc` has them as a comment at its end; an instance made from
   an earlier template has no such comment, and the three parts are these:

   ```jsonc
   "durable_objects": {
     "bindings": [
       { "name": "STORE", "class_name": "Store" },
       { "name": "MEDIA_PROCESSOR", "class_name": "MediaProcessor" },
     ],
   },
   "migrations": [
     { "tag": "v1", "new_sqlite_classes": ["Store"] },
     { "tag": "v2-media-processor", "new_sqlite_classes": ["MediaProcessor"] },
   ],
   "containers": [
     {
       "class_name": "MediaProcessor",
       "scheduling_policy": "durable_object",
       "images": {
         "media": {
           "dockerfile": "./node_modules/kopje/container/Dockerfile",
           "build_context": "./node_modules/kopje/container",
         },
       },
     },
   ],
   ```

3. Deploy. The first deploy builds and pushes the image, which takes a few minutes. Then check it:

   ```sh
   npm run admin -- media-processor probe
   ```

It starts the container on each instance type Kopje uses (normalize on standard-4 with ffmpeg's threads at 4, the
choice measured for #1828; stills on standard-1), runs one operation on a 2-second clip that ships in the package,
destroys the container, and prints what it saw. For `normalize@standard-4` that is its activation probe, whose verdict
it records for the deployed version; it writes the Store, so it is refused while the instance is in maintenance or
read-only. Each image Kopje builds is about 300 MB in your account's
container registry; delete the images of versions you no longer deploy (`npx wrangler containers images list`).

The `v2-media-processor` migration is permanent: once deployed, it is never edited or removed. To turn the processor
off, remove only the `"containers"` entry and deploy; keep the export, the binding and the migration, and the probe
then answers `no-container`. Removing `MediaProcessor` altogether takes another migration that deletes the class
(`{ "tag": "v3-remove-media-processor", "deleted_classes": ["MediaProcessor"] }`) along with the binding and the
export.

## Updates

The `kopje` version in `package.json` is the instance's version. On GitHub,
[`.github/dependabot.yml`](.github/dependabot.yml) makes Dependabot open pull requests for new versions of `kopje` and
`wrangler` and of the actions in `.github/workflows`, none merged automatically. Merging a `kopje` pull request deploys
the new version, and the Store upgrades its schema by itself; the pull request shows the version's release notes. Read
[upgrade.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/upgrade.md) before your first update: it
explains what happens and how to roll back.

A repository without the file (one made without the button, for example) can copy it from
[`deploy/.github/dependabot.yml`](https://github.com/shuymn/kopje/blob/main/deploy/.github/dependabot.yml). A
repository made from an earlier template has a `renovate.json` for the Renovate app instead. It keeps working; to move
to Dependabot, delete it and add the file, since the two would open the same pull requests. On GitLab, or
without either, update the version yourself as
[upgrade.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/upgrade.md) describes.

## Without the button

Make a repository from this directory yourself (copy it, or download it from the `deploy/` directory of
[shuymn/kopje](https://github.com/shuymn/kopje)), then create the resources the button would create:

```sh
npm install
npx wrangler login
npx wrangler queues create my-kopje-queue
npx wrangler queues create my-kopje-queue-dlq
npx wrangler r2 bucket create my-kopje-media
npx wrangler deploy
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put USER_KEK
```

`wrangler deploy` creates the Worker and the Store's Durable Object namespace. Commit the `package-lock.json` that
`npm install` wrote. Then deploy every change in one of two ways:

- **Workers Builds.** In the dashboard, open the Worker, then Settings, Build, and connect the repository. Keep the
  root directory `/` (or the directory you copied this template to), the build command empty and the deploy command
  `npx wrangler deploy`. Every push to the production branch deploys.
- **GitHub Actions.** Copy `ci/github-actions-deploy.yml` to `.github/workflows/deploy.yml`, and add two repository
  secrets: `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`, an API token made from the "Edit Cloudflare Workers"
  template with the permission Account, Queues, Edit added. Every push to `main` deploys.

Use one of the two, not both.

## License

Apache-2.0, as Kopje. See [LICENSE](https://github.com/shuymn/kopje/blob/main/LICENSE) and
[NOTICE](https://github.com/shuymn/kopje/blob/main/NOTICE).
