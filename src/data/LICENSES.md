# Licenças dos dados do conversor

Este diretório traz as tabelas e os templates usados pelo motor do conversor Flashforge. Veja `../../NOTICE` para a matriz completa com autores e links de origem.

| Arquivo | Origem | Licença |
|---|---|---|
| `bambu_to_orca.json` | Tabelas extraídas de `iChristGit/3MF-to-AD5X` (`bambu2ad5x.py`, commit `e20f81e`, 2026-11-07) por `tools/extract_mapping.py` do pacote de referência Python. | MIT © 2026 iChristGit |
| `printers/ad5x/template.json` | `ad5x_template.json` do `3MF-to-AD5X` (projeto salvo pelo OrcaSlicer 2.3.2 com o perfil oficial Flashforge AD5X). | Arquivo distribuído sob MIT, **mas os valores derivam de perfis OrcaSlicer (AGPL-3.0)**. |
| `printers/adventurer5m/template.json`, `printers/adventurer5mpro/template.json`, `printers/*/presets.generated.json`, `printers/*/filaments.generated.json` | Gerados por `tools/build_templates.py` da referência Python a partir dos perfis de sistema do **Flash Studio 1.7.9** (AppImage Linux oficial, vendor Flashforge 02.01.01.00; fork do OrcaSlicer). | **AGPL-3.0** (Flash Studio/OrcaSlicer). |
| `printers/creator5/template.json`, `printers/creator5/presets.generated.json`, `printers/creator5/filaments.generated.json`, idem `creator5pro` | Gerados por `../../scripts/build-templates.mjs` a partir dos perfis de sistema do **Flash Studio Desktop** (Windows, vendor Flashforge). | **AGPL-3.0** (Flash Studio/OrcaSlicer). |
| `printers/*/printer.json` | Metadados (limites, slots, aliases) escritos para este módulo. | AGPL-3.0 (parte deste módulo). |

Para o motor em `../engine.ts`, `../model3mf.ts`, `../util.ts`, veja o cabeçalho de cada arquivo e `../../NOTICE` para a atribuição MIT do 3MF-to-AD5X. **SlicerBridge** (GPL-3.0) **não foi copiado nem consultado**.
