# コード概略

## プロジェクト構成

```text
src/
├── types.ts                         共通型定義・物理定数
├── presets.ts                       想定サイクリストのプリセットパラメータ
├── index.ts                         パブリックAPI（re-export）
├── course-gradient/
│   └── analyzer.ts                  ウェイポイントから標高・勾配プロファイルを構築
├── physics/
│   └── power.ts                     自転車走行の出力モデル
├── optimization/
│   ├── assumed-speed.ts             P_0ベースで勾配ごとの想定速度を求める最適化
│   ├── lut.ts                       NFD係数LUTの生成と近傍勾配解決
│   └── smoothing.ts                 標高平滑化ユーティリティ
└── nfd/
    └── calculator.ts                係数補間とNFD計算

ui/
├── main.js                          OSMルート可視化、NFD解析画面
└── grade-coeff.js                   勾配係数テーブル生成画面
```

---

## 各モジュールの概要

### `types.ts`

- **`CyclistParams`**：質量・空気抵抗・転がり抵抗・`flatPower(P_0)` 等のサイクリスト物理パラメータ。
- **`CyclistLevel`**：`"beginner" | "intermediate" | "advanced" | "pro"`
- **`CourseSection`**：`{ distance: number; grade: number }`（距離 m、勾配 %）
- **`NfdLut`**：`Map<number, number>`（勾配 % → NFD係数）
- 定数：`G = 9.81`、`AIR_DENSITY = 1.2`

### `presets.ts`

日本人平均体格のサイクリストがロードバイクに乗った場合のプリセット：

| レベル | P_0 |
| ------ | --- |
| 初級 | 100 W |
| 中級 | 150 W |
| 上級 | 200 W |
| Pro | 250 W |

共通：体重 60 kg（日本人男女平均の中間）、自転車 8 kg、合計質量 68 kg、C_rr 0.004、C_dA 0.32 m²、v_min 4 km/h

### `physics/power.ts`

- **`equilibriumPower(v, grade, params)`**：速度 v (m/s)、勾配 grade (%) での均衡出力 (W)。負値は惰性走行可能を意味する。
- **`speedForPower(targetPower, grade, params)`**：均衡出力が targetPower になる速度 (m/s)。二分探索で算出し、`vMin` 下限を適用。

### `optimization/standard-course.ts`

- 旧方式（標準コース分布ベース）の残存モジュール。現行計算では使わない。

### `optimization/assumed-speed.ts`

- **`computeAssumedSpeeds(params, grades?)`**：`P_0` と最適化式に基づいて、各勾配の想定速度マップを返す。
- **`validateArithmeticGradeBins(grades)`**：勾配ビンが有限値・昇順・等差数列であることを検証する。
- 既定の `DEFAULT_GRADE_BINS` は `-30.0%..+30.0%` を `0.1%` 刻みで離散化した 601 ビン。

### `optimization/lut.ts`

- **`loadFactor(v, grade, params)`**：負荷係数 `max(0, P_eq)⁴ / v`。
- **`buildNfdLut(params, grades?)`**：全勾配の想定速度を計算し、s(n)/s(0) の LUT を構築して返す。
- **`findClosestGradeBin(grade, bins)`**：最近傍勾配ビンを返す。等差ビンではインデックス計算で O(1)、非等差ビンでは走査フォールバック。
- **`computeCourseTime(sections, speedsMap)`** / **`computeEstimatedNp(sections, speedsMap, params)`**：上記の勾配ビン解決を利用してコース時間・推定NPを算出。

### `nfd/calculator.ts`

- **`interpolateCoefficient(grade, lut)`**：LUTにない勾配を線形補間（範囲外は末端値に固定）。
    等差キーLUTでは、キー配列をLUTごとに一度だけ解析・キャッシュし、添字計算で補間する（O(1)）。
    非等差キーLUTは後方互換のため従来の走査ベースへフォールバックする。
- **`computeNfd(sections, lut)`**：`Σ distance_i × c(grade_i)` でNFD (m) を返す。
- **`computeNfdKm(sections, lut)`**：NFD (km) を返す。

### `course-gradient/analyzer.ts`

- **`buildCourseProfileFromWaypoints(...)`**：標高取得・平滑化・等間隔化を行い、解析用プロファイルを構築。
- **`computeNfdFromWaypoints(...)`**：プロファイル勾配に対して `interpolateCoefficient` を適用し、NFDを計算。
- **`GsiDemPngTileElevationProvider`**：地理院DEM PNGタイル（`*.png`）を読み込む標高プロバイダ。
- **`GsiDemPngTileElevationProvider` の実装注記**：ブラウザ実行時は `createImageBitmap` + Canvas 経由でRGBAを取得し、標高へ変換する。
- **`GsiDemPngTileElevationProvider` の変換式**：地理院仕様に準拠（`x = 2^16R + 2^8G + B`, `u = 0.01m`）。
- **`parseGsiDemPngRgbaTile(...)`**：PNGタイルのRGBAデータを 256x256 の標高格子へ変換。

---

## データフロー

```text
CyclistParams (+ optional grade bins)
    → computeAssumedSpeeds()     : Map<grade, speed>
    → buildNfdLut()              : NfdLut (Map<grade, coefficient>)
    → computeNfd(sections, lut)  : NFD in metres
```

UIからの呼び出しでは、勾配に対する係数取得を `interpolateCoefficient` 経由に統一し、UI側で補間ロジックを持たない。

標高タイル取得は PNG provider に一本化している。

---

## テスト

各モジュールに対応する `.test.ts` ファイルを `src/` 以下に配置：

| テストファイル | 対象 |
| -------------- | ------ |
| `src/physics/power.test.ts` | `equilibriumPower`、`speedForPower` |
| `src/optimization/optimization.test.ts` | `computeAssumedSpeeds`、`buildNfdLut`、`loadFactor` |
| `src/nfd/calculator.test.ts` | `interpolateCoefficient`、`computeNfd`、`computeNfdKm`、レベル間比較 |
| `src/course-gradient/analyzer.test.ts` | 標高プロファイル構築、外部標高プロバイダ連携、NFD算出フロー |

`npm test` で Jest を使って実行する。

---

## 今後の実装予定

1. **OSMウェイから勾配を算出するライブラリ**：国土地理院DEMタイルと組み合わせた標高補間（トンネル・橋梁の処理を含む）。
2. **勾配統計ツール**：国道・都道府県道のデータを収集し、分析や可視化に活用する。
3. **UIツール**：指定したコースデータからNFDを表示するWebフロントエンド。
