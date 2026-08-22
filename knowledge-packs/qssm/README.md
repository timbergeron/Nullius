# QSS-M knowledge pack

Teaches Nullius about the QSS-M engine: current source, the console command and
variable catalog, project documentation, and commit history.

## Requirements

A local QSS-M checkout exposed through the pack's `qssm` source mount:

```bash
KNOWLEDGE_SOURCE_QSSM=/home/woods/codedev/QSS-M
```

The manifest never chooses an arbitrary environment variable or filesystem root. Nullius
derives `KNOWLEDGE_SOURCE_QSSM` from `"mount": "qssm"`, and every source path must remain
inside that operator-approved root.

The `commands` source downloads a published Google Sheets CSV at build time and
needs no credentials. Everything else is read from the local checkout.

## Build the index

```bash
export KNOWLEDGE_SOURCE_QSSM=/home/woods/codedev/QSS-M
npm run knowledge:validate -- qssm
npm run knowledge:build -- qssm
```

The index is written to `data/knowledge/qssm.sqlite`, which is generated data and
stays out of Git. Rebuild it whenever the checkout moves or the sheet changes.
A source-only rebuild is detected by the running bot on its next lookup. Restart Nullius
after changing the manifest itself.

## Check the answers

```bash
npm run knowledge:test -- qssm
```

`evaluations.json` holds retrieval questions with the file, catalog entry, or
symbol each answer must be grounded in. Positive expectations must appear within the top
three results unless they specify another `maxRank`; forbidden evidence and off-topic
activation are checked too. The current suite contains 35 domain questions and 9
adversarial off-topic questions.

## Reproduce it on another machine

```bash
git clone https://github.com/timbergeron/Nullius.git
git clone https://github.com/timbergeron/QSS-M.git
cd Nullius
npm ci
export KNOWLEDGE_SOURCE_QSSM="$(cd ../QSS-M && pwd)"
npm run knowledge:build -- qssm
npm run knowledge:test -- qssm
npm run knowledge:query -- qssm "what does r_skywind do?"
```

Record `git -C ../QSS-M rev-parse HEAD` if another operator must reproduce the same source
snapshot. The commands-and-variables sheet is intentionally live; export it into this pack
and use a local `path` instead of `url` if the catalog must also be byte-for-byte pinned.

For a reusable manifest template and the complete schema, see
[`public/knowledge-packs.html`](../../public/knowledge-packs.html).
