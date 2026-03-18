# normalized-flat-distance

サイクリングコースの加法的な難易度指標 **Normalized Flat Distance (NFD)** を開発実装する。

## 概要

NFD は、サイクリングコースの各区間を勾配に応じた係数で重み付けした「平地換算距離」です。
同じ距離でも急坂区間は平地より大きく、下り坂区間は小さく換算されます。
また、NFD は**加法的**な指標です：コースを分割した各部分の NFD の合計がコース全体の NFD に等しくなります。

詳細は `docs/` ディレクトリを参照してください。

## ドキュメント

- [`docs/design.md`](docs/design.md)：要件・物理モデル・設計の根拠
- [`docs/code-overview.md`](docs/code-overview.md)：コード構成とモジュール概要
- [`docs/development-log.md`](docs/development-log.md)：開発履歴とエージェントの判断記録

## 使い方（TypeScript）

```typescript
import {
  CYCLIST_PRESETS,
  buildNfdLut,
  computeNfdKm,
} from "normalized-flat-distance";

// 中級サイクリストの NFD 係数 LUT を構築
const lut = buildNfdLut(CYCLIST_PRESETS.intermediate);

// コースを区間ごとに定義（距離: m, 勾配: %）
const course = [
  { distance: 5000, grade: 0 },   // 平地 5 km
  { distance: 3000, grade: 8 },   // 8% の登坂 3 km
  { distance: 2000, grade: -5 },  // 5% の下り 2 km
];

// NFD を計算（km 単位）
const nfd = computeNfdKm(course, lut);
console.log(`NFD: ${nfd.toFixed(2)} km`);
```

## セットアップ

```bash
npm install
npm test   # テスト実行
npm run build  # TypeScript コンパイル
```
