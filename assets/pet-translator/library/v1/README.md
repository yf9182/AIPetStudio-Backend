# Pet Translator sound library v1

This directory is the reviewable, versioned bundle used by `HUMAN_TO_PET`.
`manifest.json` is the source of truth for the mapping, provenance and file
hashes. The Worker reads only the imported private R2 copy; it never fetches a
source page during a request.

## Product mapping

The labels describe the playback use in the product. They are entertainment
categories and do not claim that an animal sound has a scientifically proven
one-to-one emotional meaning.

| English key | 产品表达 | Cat clips | Dog clips |
| --- | --- | ---: | ---: |
| `happy` | 开心 | 4 | 4 |
| `excited` | 兴奋 | 4 | 4 |
| `affectionate` | 亲昵 | 4 | 4 |
| `calm` | 平静 | 4 | 4 |
| `curious` | 好奇 | 4 | 4 |
| `play_invitation` | 邀请玩耍 | 4 | 4 |
| `attention_seeking` | 寻求关注 | 4 | 4 |
| `displeased` | 不满 | 4 | 4 |
| `afraid` | 害怕 | 4 | 4 |
| `alert` | 警戒 | 4 | 4 |

Each category has low, medium and high intensity candidates. The fourth clip
reuses the medium intensity slot so that deterministic selection can still
provide variation without copying or pitch-shifting a file. Selection filters
species and label first, then chooses the nearest intensity and hashes the
translation task ID to pick among ties.

## Provenance and review

All v1 candidates are downloaded from the Freesound pages recorded in the
manifest and marked `CC0`; the manifest also records title, author, license
URL, download date (`2026-09-08`) and SHA-256. Files are normalized mono MP3s
between 2 and 5 seconds. The checked-in candidates are intentionally
`pending` until a reviewer listens to every clip and rejects human speech,
music, obvious background noise, duplicate recordings or the wrong species.
Only rows marked `approved` may be imported for matching.

```sh
npm run pet-sounds:validate
npm run pet-sounds:sql
```

After review, update the corresponding `review_status` values, validate again,
import the files and SQL into the private R2/D1 resources, then set
`PET_TRANSLATOR_AUDIO_LIBRARY_READY=true` only after the approved count reaches
`PET_TRANSLATOR_SOUND_LIBRARY_MIN_APPROVED`.

```sh
node scripts/import-pet-sounds.mjs --upload --remote
```

The library prefix is long-lived. Task expiry and account deletion remove task
results and signed access, but never delete these shared sound files.
