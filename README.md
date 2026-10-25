# Diorama GBA

Emulador de Game Boy Advance para o browser que separa a imagem do jogo em camadas e as mostra em 3D, no ecrã ou em cima de uma mesa real com realidade aumentada (WebXR no Chrome para Android).

## Como funciona

O GBA desenha cada imagem com 4 fundos (BG0 a BG3) e os sprites, cada um com uma prioridade de 0 (à frente) a 3 (atrás). Em vez de juntar tudo numa imagem, `js/layered.js` desenha cada par (prioridade, fundo ou sprite) num plano próprio. No Pokémon FireRed isso dá:

- chão (BG3)
- cenário de baixo, como paredes e troncos (BG2)
- personagens (sprites de prioridade 2)
- telhados e copas das árvores (BG1)
- caixas de texto e menus (BG0)

Os planos são texturas numa cena three.js. No modo AR, a app usa o hit-test do WebXR para pousar o diorama numa superfície e a DOM overlay para os comandos táteis.

## Usar

1. Abre o site no Chrome do telemóvel (precisa de https para o AR).
2. Toca em **Abrir ROM** e escolhe um `.gba` ou `.zip` com uma ROM tirada de um cartucho teu.
3. Toca em **Ver na mesa (AR)**, aponta para a mesa e toca no ecrã para pousar o jogo.

Os jogos guardados ficam no browser e podem ser exportados e importados no menu ☰.

## Conteúdo

- `vendor/gbajs/`: [GBA.js](https://github.com/endrift/gbajs) de Jeffrey Pfau (licença BSD de 2 cláusulas, ver `vendor/gbajs/COPYING`), com duas pequenas alterações marcadas com `diorama:`.
- `vendor/three.min.js`: three.js r128 (licença MIT).
- `roms/vila-teste.gba`: ROM de teste original, gerada por `tools/testrom/` (precisa de `clang` e `ld.lld`: `cd tools/testrom && python3 gen.py && bash build.sh`).

Este repositório não inclui nem distribui jogos comerciais.
