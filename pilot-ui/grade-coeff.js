import { CYCLIST_PRESETS, buildNfdLut, computeAssumedSpeeds } from "../src/index";
import { equilibriumPower } from "../src/physics/power";

const crrInput = document.getElementById("crrInput");
const cdaInput = document.getElementById("cdaInput");
const p0Input = document.getElementById("p0Input");
const minGradeInput = document.getElementById("minGradeInput");
const maxGradeInput = document.getElementById("maxGradeInput");
const stepGradeInput = document.getElementById("stepGradeInput");
const generateButton = document.getElementById("generateButton");
const csvButton = document.getElementById("csvButton");
const summary = document.getElementById("summary");
const error = document.getElementById("error");
const resultBody = document.getElementById("resultBody");

/** @type {Array<{grade:number, speedKmh:number, powerW:number, coeff:number}>} */
let latestRows = [];

function setError(message) {
  error.textContent = message;
}

function clearError() {
  error.textContent = "";
}

function toCsvCell(value) {
  const text = String(value ?? "");
  if (/[,"]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function triggerDownload(filename, content, mimeType = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildGrades(minGrade, maxGrade, step) {
  const grades = [];
  for (let g = minGrade; g <= maxGrade; g += step) grades.push(g);
  if (!grades.includes(0)) grades.push(0);
  grades.sort((a, b) => a - b);
  return grades;
}

function renderTable(rows) {
  resultBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");

    const tdGrade = document.createElement("td");
    tdGrade.textContent = row.grade.toFixed(0);

    const tdSpeed = document.createElement("td");
    tdSpeed.textContent = row.speedKmh.toFixed(2);

    const tdPower = document.createElement("td");
    tdPower.textContent = row.powerW.toFixed(1);

    const tdCoeff = document.createElement("td");
    tdCoeff.textContent = row.coeff.toFixed(6);

    tr.appendChild(tdGrade);
    tr.appendChild(tdSpeed);
    tr.appendChild(tdPower);
    tr.appendChild(tdCoeff);
    resultBody.appendChild(tr);
  }
}

function generate() {
  clearError();

  const crr = Number(crrInput.value);
  const cda = Number(cdaInput.value);
  const p0 = Number(p0Input.value);
  const minGrade = Math.round(Number(minGradeInput.value));
  const maxGrade = Math.round(Number(maxGradeInput.value));
  const step = Math.round(Number(stepGradeInput.value));

  if (!Number.isFinite(crr) || !Number.isFinite(cda) || !Number.isFinite(p0)) {
    setError("数値入力が不正です。");
    return;
  }
  if (crr <= 0 || cda <= 0 || p0 <= 0) {
    setError("Crr, CdA, P_0 は正の値を指定してください。");
    return;
  }
  if (!Number.isFinite(minGrade) || !Number.isFinite(maxGrade) || !Number.isFinite(step) || step <= 0) {
    setError("勾配範囲の指定が不正です。");
    return;
  }
  if (minGrade > maxGrade) {
    setError("勾配下限は上限以下にしてください。");
    return;
  }

  const grades = buildGrades(minGrade, maxGrade, step);

  const params = {
    ...CYCLIST_PRESETS.intermediate,
    Crr: crr,
    CdA: cda,
    flatPower: p0,
  };

  const lut = buildNfdLut(params, grades);
  const speeds = computeAssumedSpeeds(params, grades);

  const rows = grades.map((grade) => {
    const v = speeds.get(grade) ?? 0;
    const pEff = Math.max(0, equilibriumPower(v, grade, params));
    return {
      grade,
      speedKmh: v * 3.6,
      powerW: pEff,
      coeff: lut.get(grade) ?? 0,
    };
  });

  latestRows = rows;
  renderTable(rows);

  const c0 = lut.get(0);
  summary.textContent = `生成完了: ${rows.length}件 / c(0)=${typeof c0 === "number" ? c0.toFixed(6) : "N/A"}`;
}

generateButton.addEventListener("click", generate);

csvButton.addEventListener("click", () => {
  if (!latestRows.length) {
    setError("先に係数表を生成してください。");
    return;
  }
  clearError();

  const lines = ["grade_percent,speed_kmh,power_w,nfd_coefficient"];
  for (const row of latestRows) {
    lines.push([
      row.grade,
      row.speedKmh.toFixed(6),
      row.powerW.toFixed(2),
      row.coeff.toFixed(10),
    ].map(toCsvCell).join(","));
  }

  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  triggerDownload(`nfd-grade-coeff-${timestamp}.csv`, lines.join("\n"));
});

generate();
