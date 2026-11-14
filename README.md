# @extruvo/converter

Módulo AGPL-3.0 isolado que converte um projeto 3MF do Bambu Studio / MakerWorld em um projeto 3MF utilizável pelo Flash Studio (Flashforge AD5X, Adventurer 5M, Adventurer 5M Pro, Creator 5, Creator 5 Pro), pelo Creality Print (57 modelos Creality incluindo K1, K1C, K1 Max, K1 SE, K2 / K2 Plus / K2 Pro / K2 SE, Ender series, CR series, Hi, SPARKX, Sermoon) e pelo OrcaSlicer. É o mesmo conversor que a aplicação Extruvo usa; esta pasta é o único local onde o motor e os perfis derivados dos vendors existem.

## Por que este módulo é AGPL-3.0

Os perfis de máquina/processo/filamento usados pelos templates deste módulo foram derivados dos perfis oficiais do **Flash Studio** e do **OrcaSlicer**, ambos licenciados sob **AGPL-3.0**. Quando este conversor é servido pela rede (SaaS público), a AGPL §13 exige que a fonte correspondente esteja disponível aos usuários da rede. Ver `NOTICE` para a lista completa de origens e as opções de conformidade.

A lógica de cópia dos ajustes do autor, decodificação de pintura, torre de purga e reposicionamento vem de `iChristGit/3MF-to-AD5X` (MIT); a atribuição está em `NOTICE`. Código do SlicerBridge (GPL-3.0) **não foi copiado nem consultado**.

## Fronteira arquitetural

A aplicação Extruvo (fora deste diretório) **não importa código TypeScript deste módulo**. A única interface permitida é o worker empacotado em `dist/converter.worker.js`, acessado por URL e trocando mensagens no protocolo definido em `src/protocol.ts`. Isso mantém o restante do Extruvo fechado e o módulo publicável sob AGPL-3.0 em um repositório próprio.

Fluxo:

```
app Extruvo (closed)      modules/extruvo-converter (AGPL-3.0)
──────────────────       ──────────────────────────────────────
MakerWorldConverter  ──► makerWorldConverterClient
       │                       │
       │                 new Worker(converterWorkerUrl)
       │                       │
       ▼                       ▼
UploadZone (File)        dist/converter.worker.js
                         ├── onmessage({ type: 'list_printers' })
                         │     └► { type: 'printers', list }
                         └── onmessage({ type: 'convert', input, options })
                               ├► { type: 'progress', ... } (opcional)
                               └► { type: 'result', output } | { type: 'error' }
```

O bundle do worker é produzido por `scripts/build-worker.mjs` (esbuild). O arquivo gerado é standalone: inclui JSZip e todos os templates de impressora.

## Impressoras incluídas

| ID              | Modelo                         | Mesa (XYZ)             | Bicos | Observações |
|-----------------|--------------------------------|------------------------|-------|-------------|
| `ad5x`          | Flashforge AD5X                | 220 × 220 × 220 mm    | 1 (+IFS 4) | Perfil validado 3MF-to-AD5X (MIT) + overlay do perfil oficial (AGPL). |
| `adventurer5m`  | Flashforge Adventurer 5M       | 220 × 220 × 220 mm    | 1 | Template oficial AGPL. |
| `adventurer5mpro` | Flashforge Adventurer 5M Pro | 220 × 220 × 220 mm    | 1 | Template oficial AGPL. |
| `creator5`      | Flashforge Creator 5           | 256 × 256 × 256 mm    | 4 independentes | Multi-toolhead nativo, sem CFS; template derivado do Flash Studio Desktop. |
| `creator5pro`   | Flashforge Creator 5 Pro       | 256 × 256 × 256 mm    | 4 independentes | Multi-toolhead nativo + câmara aquecida 65 °C. |
| `creality-<modelo>-<bico>` | 57 modelos Creality (108 variantes com bicos 0.2/0.4/0.6/0.8) | varia por modelo | 1 bico | Derivado de SoftFever/OrcaSlicer @v2.5.0 (commit `40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19`). Famílias K1 _CFS-C e K2 (nativamente CFS) têm 4 slots lógicos; demais 57 famílias são monofilamento — projeto multicolor é aceito com aviso/pendência, e a UI oferece o botão "Fundir em 1 filamento". |

## Protocolo do worker

### Lista de impressoras

```
request:  { type: 'list_printers', id?: string }
response: { type: 'printers', id?, list: Array<{ id, label, slots, bed_type, nozzle_count }> }
          | { type: 'error', id?, message, code }
```

### Conversão

```
request:  { type: 'convert', id?: string, input: ArrayBuffer | Uint8Array, options: {
            printer_id: 'ad5x'|'adventurer5m'|'adventurer5mpro'|'creator5'|'creator5pro',
            keep_speeds?: boolean,
            prune_unused?: boolean,
            single_filament?: boolean,
            src_name?: string,
          } }
response: { type: 'result', id?, result: { output: Uint8Array, report, status, warnings[], pending[], printer_id } }
          | { type: 'error', id?, message, code, report? }
```

A entrada é sempre os bytes do .3mf; a saída é um .3mf novo com o perfil Flashforge aplicado, geometria/pintura preservadas, placas recentralizadas e torre de purga ajustada à mesa de destino.

## Multi-toolhead (Creator 5 / 5 Pro)

Os perfis Flashforge Creator 5 e 5 Pro declaram 4 extrusores físicos independentes (`printer_extruder_id: ["1","2","3","4"]`, `nozzle_diameter: ["0.4","0.4","0.4","0.4"]`). O motor de conversão v0.3.0 mapeia os filamentos lógicos do projeto Bambu/MakerWorld para até 4 slots no projeto Flashforge, mas **não decide atribuição física bico→filamento**. O operador deve conferir no Flash Studio qual bico recebe cada filamento antes de fatiar. Projetos com mais de 4 filamentos recebem aviso e pendência.

## Gerar templates

Os templates derivados estão versionados; o script foi preservado para auditoria/regeneração:

```
# Creator 5 / Creator 5 Pro (Windows, Flash Studio Desktop)
node scripts/build-templates.mjs \
  --profiles "C:/Program Files/FlashForge/Flash Studio Desktop/resources/profiles/Flashforge" \
  --source-label "Flash Studio Desktop (vendor Flashforge Windows)"

# Creality (snapshot vendoreado do OrcaSlicer @v2.5.0)
node scripts/build-creality.mjs \
  --profiles modules/extruvo-converter/vendor/orca-creality/40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19/Creality \
  --hash 40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19 \
  --tag v2.5.0
```

Para AD5X / Adventurer 5M / 5M Pro continue usando `tools/build_templates.py` do pacote de referência Python (ver `extruvo-flashforge-converter-ref/HANDOFF.md`).

### Trocando o pin do OrcaSlicer

Para atualizar o snapshot Creality para outra tag do OrcaSlicer:

1. Baixe apenas `resources/profiles/Creality.json` e `resources/profiles/Creality/` do commit desejado (sparse checkout + `git archive`, ou API raw do GitHub — a Fortaleza AGPL §13 pede que o commit exato esteja documentado). Não vendoreie o resto do repositório.
2. Grave em `vendor/orca-creality/<novo-hash>/` (mantendo o diretório anterior como auditoria se desejado).
3. Rode `build-creality.mjs` apontando para a nova pasta e atualize o hash em `NOTICE`, `README.md` e `docs/validation/conversor-agpl-creality-2026-11-13.md`.
4. Rebuild do worker: `node scripts/build-worker.mjs`.

## Testes

Os testes unitários do Extruvo (`tests/makerworld-converter.test.ts`) importam diretamente de `src/engine.ts` e do registro de impressoras — isso é interno ao módulo, equivale a rodar os testes do próprio módulo a partir do monorepo. O aplicativo em si continua falando apenas com o worker.
