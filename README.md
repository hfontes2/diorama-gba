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

## Modos

- **Ecrã**: o diorama numa mesa virtual; arrasta para rodar, pinça para aproximar.
- **AR**: WebXR com hit-test, para telemóveis com ARCore.
- **Marcador**: AR para telemóveis sem ARCore. Imprime `marcador.html` (marcador ArUco ARUCO_MIP_36h12 n.º 0, 10 cm) e aponta a câmara. A pose vem de uma homografia dos 4 cantos detetados por js-aruco2 (`js/marker.js`).
- **Estilo voxel** (menu ☰): cada píxel dos fundos vira uma coluna de blocos (chão baixo, paredes médias, telhados e árvores altos) e os sprites ficam de pé no mapa, recortados a partir da OAM (`js/voxel.js`). O deslizador de profundidade muda a altura dos blocos.
- **Mundo 3D** (menu ☰, só Pokémon FireRed e LeafGreen em inglês, versão 1.0): em vez da imagem, `js/world.js` lê da memória do jogo o mapa carregado (grelha de metatiles e colisões), os gráficos dos tilesets na VRAM e as cores na paleta. As células que bloqueiam o caminho (árvores, casas, vedações, placas) viram blocos: as duas filas de baixo ficam de pé como parede da frente e as de cima deitam-se como telhado, o que desfaz a perspetiva de cima do jogo. O chão fica plano e a água um pouco abaixo. Funciona em todos os mapas do jogo (cidades, rotas, grutas, interiores) porque é construído a partir do mapa que estiver carregado. As batalhas e outros ecrãs que não são mapa usam o estilo voxel. Os endereços de memória vêm do mapa de símbolos do projeto [pret/pokefirered](https://github.com/pret/pokefirered).
- **VR**: imagem dividida para óculos de telemóvel (tipo Cardboard), com o giroscópio a seguir a cabeça (`js/vr.js`). Joga-se com um comando Bluetooth; tocar no ecrã volta a centrar a vista.

Em todos os estilos, a camada de cima (BG0 e sprites de prioridade 0, onde o FireRed desenha caixas de texto e menus) é desenhada por cima da vista 3D, sempre legível rode-se a vista como se rodar (opção "Diálogos e menus sempre à frente"). No FireRed/LeafGreen, nos ecrãs que não são mapa (nome, menus, batalhas) o estilo voxel deita os sprites e baixa os blocos, para os cursores e setas não ficarem tapados.

## Usar

1. Abre o site no Chrome do telemóvel (precisa de https para o AR).
2. Toca em **Abrir ROM** e escolhe um `.gba` ou `.zip` com uma ROM tirada de um cartucho teu.
3. Toca em **Ver na mesa (AR)**, aponta para a mesa e toca no ecrã para pousar o jogo.

Os jogos guardados ficam no browser e podem ser exportados e importados no menu ☰.

## Conteúdo

- `vendor/gbajs/`: [GBA.js](https://github.com/endrift/gbajs) de Jeffrey Pfau (licença BSD de 2 cláusulas, ver `vendor/gbajs/COPYING`), com pequenas alterações marcadas com `diorama:`.
- `vendor/three.min.js`: three.js r128 (licença MIT).
- `vendor/aruco/`: [js-aruco2](https://github.com/damianofalcioni/js-aruco2) (licença MIT).
- `roms/vila-teste.gba`: ROM de teste original, gerada por `tools/testrom/` (precisa de `clang` e `ld.lld`: `cd tools/testrom && python3 gen.py && bash build.sh`).

Este repositório não inclui nem distribui jogos comerciais.
