# コード概略

## プロジェクト構成

```
src/
├── types.ts                         共通型定義・物理定数
├── presets.ts                       想定サイクリストのプリセットパラメータ
├── index.ts                         パブリックAPI（re-export）
├── physics/
│   └── power.ts                     自転車走行の出力モデル
├── optimization/
│   ├── standard-course.ts           標準コース勾配分布（暫定）
│   ├── assumed-speed.ts             勾配ごとの想定速度を求める最適化
│   └── lut.ts                       NFD係数LUTの生成
└── nfd/
    └── calculator.ts                NFDの計算
```

---

## 各モジュールの概要

### `types.ts`

- **`CyclistParams`**：質量・空気抵抗・転がり抵抗・FTP等のサイクリスト物理パラメータ。
- **`CyclistLevel`**：`"beginner" | "intermediate" | "advanced"`
- **`CourseSection`**：`{ distance: number; grade: number }`（距離 m、勾配 %）
- **`NfdLut`**：`Map<number, number>`（勾配 % → NFD係数）
- **`GradeFrequency`**：`{ grade: number; frequency: number }`（勾配分布の1要素）
- 定数：`G = 9.81`、`AIR_DENSITY = 1.2`

### `presets.ts`

日本人平均体格のサイクリストがロードバイクに乗った場合の3レベルのプリセット：

| レベル | FTP | 巡航パワー | v_max |
|--------|-----|-----------|-------|
| 初級 | 120 W | 78 W | 40 km/h |
| 中級 | 180 W | 117 W | 40 km/h |
| 上級 | 240 W | 156 W | 40 km/h |

共通：体重 60 kg（日本人男女平均の中間）、自転車 8 kg、合計質量 68 kg、C_rr 0.004、C_dA 0.32 m²、v_min 4 km/h

### `physics/power.ts`

- **`equilibriumPower(v, grade, params)`**：速度 v (m/s)、勾配 grade (%) での均衡出力 (W)。負値は惰性走行可能を意味する。
- **`speedForPower(targetPower, grade, params)`**：均衡出力が targetPower になる速度 (m/s)。二分探索で算出し、vMin/vMax でクリップ。

### `optimization/standard-course.ts`

- **`STANDARD_COURSE_DISTRIBUTION`**：-15% 〜 +15% の勾配に対するラプラス的な重みを持つ勾配分布。**暫定実装**（実データで置き換えること）。

### `optimization/assumed-speed.ts`

- **`computeAssumedSpeeds(params, distribution)`**：二分探索でNP制約を満たす目標パワーを求め、各勾配の想定速度マップを返す。

### `optimization/lut.ts`

- **`loadFactor(v, grade, params)`**：負荷係数 `max(0, P_eq)⁴ / v`。
- **`buildNfdLut(params, distribution?)`**：全勾配の想定速度を計算し、s(n)/s(0) の LUT を構築して返す。

### `nfd/calculator.ts`

- **`interpolateCoefficient(grade, lut)`**：LUTにない勾配は線形補間（範囲外は末端値に固定）。
- **`computeNfd(sections, lut)`**：`Σ distance_i × c(grade_i)` でNFD (m) を返す。
- **`computeNfdKm(sections, lut)`**：NFD (km) を返す。

---

## データフロー

```
CyclistParams + GradeFrequency[]
    → computeAssumedSpeeds()     : Map<grade, speed>
    → buildNfdLut()              : NfdLut (Map<grade, coefficient>)
    → computeNfd(sections, lut)  : NFD in metres
```

---

## テスト

各モジュールに対応する `.test.ts` ファイルを `src/` 以下に配置：

| テストファイル | 対象 |
|--------------|------|
| `src/physics/power.test.ts` | `equilibriumPower`、`speedForPower` |
| `src/optimization/optimization.test.ts` | 標準コース分布、`computeAssumedSpeeds`、`buildNfdLut`、`loadFactor` |
| `src/nfd/calculator.test.ts` | `interpolateCoefficient`、`computeNfd`、`computeNfdKm`、レベル間比較 |

`npm test` で Jest を使って実行する。

---

## 今後の実装予定

1. **OSMウェイから勾配を算出するライブラリ**：国土地理院DEMタイルと組み合わせた標高補間（トンネル・橋梁の処理を含む）。
2. **標準コース勾配分布の統計ツール**：国道・都道府県道のデータを収集し、実際の分布を求める。
3. **UIツール**：指定したコースデータからNFDを表示するWebフロントエンド。
