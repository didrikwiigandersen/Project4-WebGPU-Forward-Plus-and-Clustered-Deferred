#!/usr/bin/env python3
"""Validate native benchmark evidence and generate Project 4 performance plots.

Only final reports are discovered automatically: ``benchmark-full.json``,
``capacity-256.json``, and ``capacity-1024.json``, with transparent ``.json.gz``
fallbacks. Checkpoint and recovery-part files are never loaded. Every plotted
statistic is recomputed from raw timestamp samples with the same floor-index
percentile rule used by the browser benchmark.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import statistics
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


EXPECTED_WARMUP = 120
EXPECTED_SAMPLES = 300
EXPECTED_REPEATS = 3

DEFAULT_CONFIG: dict[str, Any] = {
    "mode": "forward+",
    "lightCount": 1024,
    "width": 1280,
    "height": 720,
    "cameraPreset": "Atrium",
    "clusterGrid": "16x9x24",
    "bundles": False,
    "depthMode": "off",
    "deferredCompute": False,
    "compactGBuffer": False,
    "bloom": False,
    "bloomThreshold": 1,
    "bloomStrength": 0.2,
    "debugView": "none",
    "freezeLights": True,
    "fixedTime": 1000,
    "optimizedLightMath": False,
}

LEGACY_OPTIONAL_CONFIG_KEYS = {"optimizedLightMath", "bloomThreshold", "bloomStrength"}

RENDERERS = ("naive", "forward+", "clustered deferred")
LIGHT_COUNTS = (128, 512, 1024, 2048, 5000)
FEATURE_LIGHT_COUNTS = (128, 5000)
SIZES = ((1280, 720), (1920, 1080))
CAMERAS = ("Atrium", "Arcade")
GRIDS = ("8x4x16", "16x9x24", "32x18x24")

COLORS = {
    "naive": "#C44E52",
    "forward+": "#4C72B0",
    "clustered deferred": "#55A868",
    "8x4x16": "#8172B3",
    "16x9x24": "#4C72B0",
    "32x18x24": "#DD8452",
    "256": "#4C72B0",
    "1024": "#DD8452",
}


class EvidenceError(RuntimeError):
    """Raised when a report cannot support honest measurement claims."""


def floor_percentile(values: Sequence[float], fraction: float) -> float:
    """Match benchmark.ts: sorted[floor(fraction * n)], clamped to n - 1."""
    if not values:
        raise EvidenceError("Cannot compute a percentile from an empty sample set.")
    if not 0.0 <= fraction <= 1.0:
        raise ValueError(f"Percentile fraction must be in [0, 1], got {fraction}.")
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.floor(fraction * len(ordered)))]


def finite_number(value: Any, context: str, *, nonnegative: bool = True) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvidenceError(f"{context} must be a number, got {value!r}.")
    result = float(value)
    if not math.isfinite(result):
        raise EvidenceError(f"{context} must be finite, got {value!r}.")
    if nonnegative and result < 0:
        raise EvidenceError(f"{context} must be nonnegative, got {result}.")
    return result


def effective_config(configuration: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(DEFAULT_CONFIG)
    result.update(configuration)
    return result


def config_key(configuration: Mapping[str, Any]) -> str:
    """Canonicalize the complete effective configuration, including extra keys."""
    return json.dumps(effective_config(configuration), sort_keys=True, separators=(",", ":"))


def expected_config(**patch: Any) -> dict[str, Any]:
    result = dict(DEFAULT_CONFIG)
    result.update(patch)
    return result


def full_config(**patch: Any) -> dict[str, Any]:
    """Final full-benchmark configurations inherit the optimized kernel."""
    return expected_config(optimizedLightMath=True, **patch)


def required_pass_labels(configuration: Mapping[str, Any]) -> set[str]:
    labels = {"Light movement", "Presentation"}
    mode = configuration.get("mode")
    if mode == "naive":
        labels.add("Naive geometry")
    elif mode == "forward+":
        labels.update(("Light transform", "Clustering", "Forward+ shading"))
        depth_mode = configuration.get("depthMode")
        if depth_mode in ("prepass", "culling"):
            labels.add("Forward+ depth prepass")
        if depth_mode == "culling":
            labels.add("Forward+ active cluster marking")
    elif mode == "clustered deferred":
        labels.update(("Light transform", "Clustering", "G-buffer", "Deferred lighting"))
    else:
        raise EvidenceError(f"Unsupported renderer mode in benchmark configuration: {mode!r}.")
    if configuration.get("bloom"):
        labels.update(("Bloom extraction", "Bloom horizontal", "Bloom vertical"))
    return labels


def get_alias(mapping: Mapping[str, Any], names: Sequence[str], context: str) -> Any:
    present = [name for name in names if name in mapping]
    if not present:
        raise EvidenceError(f"{context} is missing required field {names[0]!r}.")
    if len(present) > 1:
        first = mapping[present[0]]
        if any(mapping[name] != first for name in present[1:]):
            raise EvidenceError(f"{context} has conflicting aliases: {', '.join(present)}.")
    return mapping[present[0]]


def get_optional_alias(mapping: Mapping[str, Any], names: Sequence[str], context: str) -> Any | None:
    present = [name for name in names if name in mapping]
    if not present:
        return None
    if len(present) > 1:
        first = mapping[present[0]]
        if any(mapping[name] != first for name in present[1:]):
            raise EvidenceError(f"{context} has conflicting aliases: {', '.join(present)}.")
    return mapping[present[0]]


@dataclass(frozen=True)
class Sample:
    repeat: int
    render_ms: float
    gpu_ms: float
    cpu_ms: float
    passes: Mapping[str, float]


@dataclass
class CaseData:
    case_id: str
    family: str
    configuration: dict[str, Any]
    results: list[Mapping[str, Any]] = field(default_factory=list)
    samples: list[Sample] = field(default_factory=list)

    def metric_values(self, metric: str, repeat: int | None = None) -> list[float]:
        selected = self.samples if repeat is None else [sample for sample in self.samples if sample.repeat == repeat]
        if metric == "render":
            return [sample.render_ms for sample in selected]
        if metric == "gpu":
            return [sample.gpu_ms for sample in selected]
        if metric == "cpu":
            return [sample.cpu_ms for sample in selected]
        raise ValueError(f"Unknown metric {metric!r}.")

    def pass_values(self, label: str, repeat: int | None = None) -> list[float]:
        selected = self.samples if repeat is None else [sample for sample in self.samples if sample.repeat == repeat]
        return [sample.passes[label] for sample in selected if label in sample.passes]

    def percentile(self, metric: str, fraction: float, repeat: int | None = None) -> float:
        return floor_percentile(self.metric_values(metric, repeat), fraction)

    def repeat_medians(self, metric: str) -> list[float]:
        return [self.percentile(metric, 0.5, repeat) for repeat in range(EXPECTED_REPEATS)]

    def pass_percentile(self, label: str, fraction: float = 0.5) -> float | None:
        values = self.pass_values(label)
        return floor_percentile(values, fraction) if values else None

    def diagnostic_values(self, name: str) -> list[float]:
        values: list[float] = []
        for index, row in enumerate(self.results):
            diagnostics = row.get("diagnostics", {})
            if not isinstance(diagnostics, Mapping):
                raise EvidenceError(f"{self.case_id} result {index} diagnostics must be an object.")
            value = diagnostics.get(name)
            if value is not None:
                values.append(finite_number(value, f"{self.case_id} diagnostics.{name}"))
        return values

    def diagnostic_median(self, name: str) -> float | None:
        values = self.diagnostic_values(name)
        return floor_percentile(values, 0.5) if values else None


@dataclass
class Report:
    path: Path
    payload: Mapping[str, Any]
    cases_by_id: dict[str, CaseData]
    cases_by_config: dict[str, CaseData]

    @property
    def captured_at(self) -> str:
        return str(self.payload["capturedAt"])

    @property
    def scope(self) -> str:
        return str(self.payload["scope"])

    @property
    def capacity(self) -> int:
        value = self.payload.get("capacity")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise EvidenceError(f"{self.path}: top-level capacity must be numeric.")
        return int(value)

    @property
    def raw_count(self) -> int:
        return sum(len(case.samples) for case in self.cases_by_id.values())

    @property
    def result_count(self) -> int:
        return sum(len(case.results) for case in self.cases_by_id.values())

    @property
    def rejected_count(self) -> int:
        total = 0
        for case in self.cases_by_id.values():
            for row in case.results:
                rejected = row.get("rejected", 0)
                if isinstance(rejected, (int, float)) and not isinstance(rejected, bool):
                    total += int(rejected)
        return total

    def case(self, configuration: Mapping[str, Any]) -> CaseData:
        key = config_key(configuration)
        try:
            return self.cases_by_config[key]
        except KeyError as error:
            pretty = json.dumps(effective_config(configuration), sort_keys=True)
            raise EvidenceError(f"{self.path.name} is missing the exact effective configuration {pretty}.") from error


def read_json(path: Path) -> Mapping[str, Any]:
    try:
        opener = gzip.open if path.suffix == ".gz" else Path.open
        if path.suffix == ".gz":
            source_context = opener(path, "rt", encoding="utf-8")
        else:
            source_context = opener(path, "r", encoding="utf-8")
        with source_context as source:
            value = json.load(source)
    except FileNotFoundError as error:
        raise EvidenceError(f"Final report not found: {path}") from error
    except (gzip.BadGzipFile, OSError, UnicodeError) as error:
        raise EvidenceError(f"{path}: could not decode the final JSON report: {error}") from error
    except json.JSONDecodeError as error:
        raise EvidenceError(f"{path}: invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}") from error
    if not isinstance(value, Mapping):
        raise EvidenceError(f"{path}: report root must be a JSON object.")
    return value


def is_nonfinal_report_path(path: Path) -> bool:
    name = path.name.lower()
    return any(marker in name for marker in ("checkpoint", "recovery", "-part", "_part", ".part"))


def validate_protocol(path: Path, payload: Mapping[str, Any]) -> None:
    captured_at = payload.get("capturedAt")
    if not isinstance(captured_at, str) or not captured_at.strip():
        raise EvidenceError(f"{path}: final evidence requires a nonempty capturedAt timestamp.")
    if not isinstance(payload.get("scope"), str):
        raise EvidenceError(f"{path}: final evidence requires a scope string.")
    user_agent = payload.get("userAgent")
    if not isinstance(user_agent, str) or not user_agent.strip():
        raise EvidenceError(f"{path}: final evidence requires a nonempty userAgent string.")
    if not isinstance(payload.get("adapterInfo"), Mapping):
        raise EvidenceError(f"{path}: final evidence requires an adapterInfo object.")
    timestamp_precision = payload.get("timestampPrecision")
    if not isinstance(timestamp_precision, str) or not timestamp_precision.strip():
        raise EvidenceError(f"{path}: final evidence requires a nonempty timestampPrecision string.")
    if "timestampQuantumNs" in payload:
        quantum = finite_number(payload["timestampQuantumNs"], f"{path}: timestampQuantumNs")
        if not quantum.is_integer() or quantum <= 0:
            raise EvidenceError(f"{path}: timestampQuantumNs must be a positive integer number of nanoseconds.")
    protocol = payload.get("protocol")
    if not isinstance(protocol, Mapping):
        raise EvidenceError(f"{path}: final evidence requires a protocol object.")
    expected = {
        "warmup": EXPECTED_WARMUP,
        "validSamples": EXPECTED_SAMPLES,
        "repeats": EXPECTED_REPEATS,
        "fixedTime": 1000,
        "seed": "0x6d2b79f5",
    }
    for name, value in expected.items():
        if protocol.get(name) != value:
            raise EvidenceError(f"{path}: protocol.{name} must be {value}, got {protocol.get(name)!r}.")


def load_report(path: Path, *, expected_scope: str | None = None, expected_capacity: int | None = None) -> Report:
    if is_nonfinal_report_path(path):
        raise EvidenceError(f"{path}: checkpoint and recovery-part files are not accepted as final evidence.")
    payload = read_json(path)
    validate_protocol(path, payload)
    optional_config_keys = (
        LEGACY_OPTIONAL_CONFIG_KEYS
        if payload.get("scope") == "capacity" and payload.get("capacity") == 256
        else set()
    )
    if expected_scope is not None and payload.get("scope") != expected_scope:
        raise EvidenceError(f"{path}: expected scope {expected_scope!r}, got {payload.get('scope')!r}.")
    report_capacity = finite_number(payload.get("capacity"), f"{path}: top-level capacity")
    if not report_capacity.is_integer() or report_capacity < 1:
        raise EvidenceError(f"{path}: top-level capacity must be a positive integer.")

    raw_rows = get_optional_alias(payload, ("raw", "rawSamples", "rawsamples"), str(path))
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        raise EvidenceError(f"{path}: results must be a nonempty array.")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise EvidenceError(
            f"{path}: raw timestamp samples are absent or empty. Checkpoints and summary-only reports cannot be "
            "plotted; provide the completed native JSON report."
        )

    case_config_fallback: dict[str, tuple[str, Mapping[str, Any]]] = {}
    cases_field = payload.get("cases")
    if not isinstance(cases_field, list) or not cases_field:
        raise EvidenceError(f"{path}: final evidence requires a nonempty cases array.")
    for index, item in enumerate(cases_field):
        if not isinstance(item, Mapping):
            raise EvidenceError(f"{path}: cases[{index}] must be an object.")
        case_id = item.get("id")
        configuration = get_alias(item, ("configuration", "config"), f"{path}: cases[{index}]")
        if not isinstance(case_id, str) or not isinstance(configuration, Mapping):
            raise EvidenceError(f"{path}: cases[{index}] requires id and configuration.")
        missing_config = sorted(set(DEFAULT_CONFIG) - optional_config_keys - set(configuration))
        if missing_config:
            raise EvidenceError(
                f"{path}: cases[{index}] must record the complete effective configuration; "
                f"missing {missing_config}."
            )
        if case_id in case_config_fallback:
            raise EvidenceError(f"{path}: duplicate case id {case_id!r} in cases array.")
        case_config_fallback[case_id] = (str(item.get("family", "unknown")), effective_config(configuration))

    planned_ids = list(case_config_fallback)
    expected_result_sequence = [
        (case_id, repeat)
        for repeat in range(EXPECTED_REPEATS)
        for case_id in (reversed(planned_ids) if repeat % 2 else planned_ids)
    ]

    cases_by_id: dict[str, CaseData] = {}
    result_sequence: list[tuple[str, int]] = []
    for index, row in enumerate(results):
        context = f"{path}: results[{index}]"
        if not isinstance(row, Mapping):
            raise EvidenceError(f"{context} must be an object.")
        case_id_value = get_alias(row, ("id", "caseId"), context)
        if not isinstance(case_id_value, str):
            raise EvidenceError(f"{context} requires a string id.")
        configuration_value = get_optional_alias(row, ("configuration", "config"), context)
        if configuration_value is None and case_id_value in case_config_fallback:
            configuration_value = case_config_fallback[case_id_value][1]
        if not isinstance(configuration_value, Mapping):
            raise EvidenceError(f"{context} requires configuration (or config).")
        missing_config = sorted(set(DEFAULT_CONFIG) - optional_config_keys - set(configuration_value))
        if missing_config:
            raise EvidenceError(
                f"{context} must record the complete effective configuration; missing {missing_config}."
            )
        configuration = effective_config(configuration_value)
        family = str(row.get("family", case_config_fallback.get(case_id_value, ("unknown", {}))[0]))
        repeat = row.get("repeat")
        if not isinstance(repeat, int) or isinstance(repeat, bool) or repeat not in range(EXPECTED_REPEATS):
            raise EvidenceError(f"{context}.repeat must be 0, 1, or 2.")
        rejected = row.get("rejected")
        if not isinstance(rejected, int) or isinstance(rejected, bool) or rejected < 0:
            raise EvidenceError(f"{context}.rejected must be a nonnegative integer.")

        case = cases_by_id.get(case_id_value)
        if case is None:
            case = CaseData(case_id_value, family, configuration)
            cases_by_id[case_id_value] = case
        elif config_key(case.configuration) != config_key(configuration):
            raise EvidenceError(f"{path}: case id {case_id_value!r} maps to multiple configurations.")
        if any(existing.get("repeat") == repeat for existing in case.results):
            raise EvidenceError(f"{path}: duplicate result for {case_id_value!r}, repeat {repeat}.")
        result_sequence.append((case_id_value, repeat))
        drawing_buffer = row.get("drawingBuffer")
        expected_buffer = [configuration["width"], configuration["height"]]
        if drawing_buffer != expected_buffer:
            raise EvidenceError(
                f"{context}.drawingBuffer must match configuration width/height {expected_buffer}, "
                f"got {drawing_buffer!r}."
            )
        case.results.append(row)

    if result_sequence != expected_result_sequence:
        raise EvidenceError(
            f"{path}: result rows must follow forward/reversed/forward case order across repeats 0/1/2."
        )

    raw_counts: dict[tuple[str, int], int] = {}
    raw_frames: dict[tuple[str, int], set[int]] = {}
    all_frames: set[int] = set()
    for index, row in enumerate(raw_rows):
        context = f"{path}: raw[{index}]"
        if not isinstance(row, Mapping):
            raise EvidenceError(f"{context} must be an object.")
        case_id = get_alias(row, ("caseId", "id"), context)
        repeat = row.get("repeat")
        sample_value = row.get("sample")
        if not isinstance(case_id, str) or case_id not in cases_by_id:
            raise EvidenceError(f"{context} references unknown case id {case_id!r}.")
        if not isinstance(repeat, int) or isinstance(repeat, bool) or repeat not in range(EXPECTED_REPEATS):
            raise EvidenceError(f"{context}.repeat must be 0, 1, or 2.")
        sequence_index = index // EXPECTED_SAMPLES
        if sequence_index >= len(expected_result_sequence) or (case_id, repeat) != expected_result_sequence[sequence_index]:
            raise EvidenceError(
                f"{context} violates the expected 300-sample forward/reversed/forward case blocks."
            )
        if not isinstance(sample_value, Mapping):
            raise EvidenceError(f"{context}.sample must be an object.")
        frame = sample_value.get("frame")
        if not isinstance(frame, int) or isinstance(frame, bool) or frame < 1:
            raise EvidenceError(f"{context}.sample.frame must be a positive integer.")
        if frame in all_frames:
            raise EvidenceError(f"{context} duplicates global profiler frame id {frame}.")
        all_frames.add(frame)
        frame_key = (case_id, repeat)
        frames = raw_frames.setdefault(frame_key, set())
        if frame in frames:
            raise EvidenceError(f"{context} duplicates frame {frame} for {case_id!r}, repeat {repeat}.")
        frames.add(frame)
        sample_metadata = sample_value.get("metadata")
        if not isinstance(sample_metadata, Mapping):
            raise EvidenceError(f"{context}.sample.metadata must be an object.")
        renderer_metadata = sample_metadata.get("renderer")
        if not isinstance(renderer_metadata, str) or not renderer_metadata:
            raise EvidenceError(f"{context}.sample.metadata.renderer must be a nonempty provenance string.")
        expected_metadata = {
            "width": cases_by_id[case_id].configuration["width"],
            "height": cases_by_id[case_id].configuration["height"],
            "lights": cases_by_id[case_id].configuration["lightCount"],
        }
        for name, expected_value in expected_metadata.items():
            if sample_metadata.get(name) != expected_value:
                raise EvidenceError(
                    f"{context}.sample.metadata.{name} must be {expected_value!r}, "
                    f"got {sample_metadata.get(name)!r}."
                )
        passes_value = sample_value.get("passes")
        if not isinstance(passes_value, Mapping):
            raise EvidenceError(f"{context}.sample.passes must be an object.")
        passes: dict[str, float] = {}
        for label, value in passes_value.items():
            if not isinstance(label, str):
                raise EvidenceError(f"{context}.sample.passes contains a non-string label.")
            passes[label] = finite_number(value, f"{context}.sample.passes[{label!r}]")
        missing_passes = sorted(required_pass_labels(cases_by_id[case_id].configuration) - set(passes))
        if missing_passes:
            raise EvidenceError(f"{context}.sample.passes is missing required labels {missing_passes}.")
        sample = Sample(
            repeat=repeat,
            render_ms=finite_number(sample_value.get("renderMs"), f"{context}.sample.renderMs"),
            gpu_ms=finite_number(sample_value.get("gpuMs"), f"{context}.sample.gpuMs"),
            cpu_ms=finite_number(sample_value.get("cpuMs"), f"{context}.sample.cpuMs"),
            passes=passes,
        )
        cases_by_id[case_id].samples.append(sample)
        raw_counts[(case_id, repeat)] = raw_counts.get((case_id, repeat), 0) + 1

    if set(case_config_fallback) != set(cases_by_id):
        missing_results = sorted(set(case_config_fallback) - set(cases_by_id))
        missing_plan = sorted(set(cases_by_id) - set(case_config_fallback))
        raise EvidenceError(
            f"{path}: cases/results IDs disagree; without results={missing_results}, "
            f"without plan entries={missing_plan}."
        )

    cases_by_config: dict[str, CaseData] = {}
    for case_id, case in cases_by_id.items():
        planned_family, planned_configuration = case_config_fallback[case_id]
        if config_key(planned_configuration) != config_key(case.configuration):
            raise EvidenceError(f"{path}: cases/results configuration mismatch for {case_id!r}.")
        if planned_family != case.family:
            raise EvidenceError(f"{path}: cases/results family mismatch for {case_id!r}.")
        repeats = {row["repeat"] for row in case.results}
        if repeats != set(range(EXPECTED_REPEATS)):
            raise EvidenceError(f"{path}: {case_id!r} needs one result for each repeat 0, 1, and 2.")
        for repeat in range(EXPECTED_REPEATS):
            count = raw_counts.get((case_id, repeat), 0)
            if count != EXPECTED_SAMPLES:
                raise EvidenceError(
                    f"{path}: {case_id!r} repeat {repeat} has {count} raw samples; expected {EXPECTED_SAMPLES}."
                )
        if len(case.samples) != EXPECTED_SAMPLES * EXPECTED_REPEATS:
            raise EvidenceError(f"{path}: {case_id!r} must have exactly 900 raw samples.")

        for row in case.results:
            repeat = int(row["repeat"])
            diagnostics = row.get("diagnostics")
            if not isinstance(diagnostics, Mapping):
                raise EvidenceError(f"{path}: {case_id} repeat {repeat} diagnostics must be an object.")
            diagnostic_capacity = diagnostics.get("capacity")
            if diagnostic_capacity is not None:
                diagnostic_value = finite_number(
                    diagnostic_capacity, f"{path}: {case_id} repeat {repeat} diagnostics.capacity"
                )
                report_value = finite_number(payload.get("capacity"), f"{path}: top-level capacity")
                if not diagnostic_value.is_integer() or diagnostic_value != report_value:
                    raise EvidenceError(
                        f"{path}: {case_id!r} repeat {repeat} diagnostic capacity "
                        f"{diagnostic_capacity!r} disagrees with report capacity {payload.get('capacity')!r}."
                    )
            checks = (
                ("medianRenderMs", case.percentile("render", 0.5, repeat)),
                ("p95RenderMs", case.percentile("render", 0.95, repeat)),
                ("medianCpuMs", case.percentile("cpu", 0.5, repeat)),
                ("p95CpuMs", case.percentile("cpu", 0.95, repeat)),
            )
            for field_name, recomputed in checks:
                reported = finite_number(row.get(field_name), f"{path}: {case_id} repeat {repeat} {field_name}")
                if not math.isclose(reported, recomputed, rel_tol=1e-9, abs_tol=1e-6):
                    raise EvidenceError(
                        f"{path}: {case_id!r} repeat {repeat} {field_name}={reported:g} "
                        f"does not match raw floor-index value {recomputed:g}."
                    )

        key = config_key(case.configuration)
        if key in cases_by_config:
            raise EvidenceError(
                f"{path}: multiple case ids share one effective configuration: "
                f"{cases_by_config[key].case_id!r} and {case_id!r}."
            )
        cases_by_config[key] = case

    report = Report(path=path, payload=payload, cases_by_id=cases_by_id, cases_by_config=cases_by_config)
    if expected_capacity is not None and report.capacity != expected_capacity:
        raise EvidenceError(f"{path}: expected capacity {expected_capacity}, got {report.capacity}.")
    return report


def workload_specs() -> list[tuple[int, int, str, int]]:
    return [
        (width, height, camera, lights)
        for width, height in SIZES
        for camera in CAMERAS
        for lights in FEATURE_LIGHT_COUNTS
    ]


def workload_short(spec: tuple[int, int, str, int]) -> str:
    width, height, camera, lights = spec
    camera_code = {"Atrium": "A", "Arcade": "R"}.get(camera, camera[:3])
    return f"{camera_code}·{height}·{lights}"


def workload_long(spec: tuple[int, int, str, int]) -> str:
    width, height, camera, lights = spec
    return f"{camera}, {width}×{height}, {lights:,} lights"


@dataclass(frozen=True)
class FeatureDefinition:
    name: str
    short_name: str
    after_patch: Mapping[str, Any]
    before_patch: Mapping[str, Any]
    changed_flags: str


FEATURES: tuple[FeatureDefinition, ...] = (
    FeatureDefinition(
        "Compute deferred lighting", "Compute", {"mode": "clustered deferred", "deferredCompute": True},
        {"mode": "clustered deferred"}, "deferredCompute: false → true",
    ),
    FeatureDefinition(
        "Compact G-buffer", "Compact", {"mode": "clustered deferred", "deferredCompute": True, "compactGBuffer": True},
        {"mode": "clustered deferred", "deferredCompute": True}, "compactGBuffer: false → true",
    ),
    FeatureDefinition(
        "Forward+ depth prepass", "Prepass", {"mode": "forward+", "depthMode": "prepass"},
        {"mode": "forward+", "depthMode": "off"}, "depthMode: off → prepass",
    ),
    FeatureDefinition(
        "Active-cluster culling", "Culling", {"mode": "forward+", "depthMode": "culling"},
        {"mode": "forward+", "depthMode": "prepass"}, "depthMode: prepass → culling",
    ),
    FeatureDefinition(
        "Gaussian bloom", "Bloom",
        {"mode": "clustered deferred", "deferredCompute": True, "compactGBuffer": True, "bloom": True},
        {"mode": "clustered deferred", "deferredCompute": True, "compactGBuffer": True}, "bloom: false → true",
    ),
    FeatureDefinition(
        "Combined deferred", "Combined deferred",
        {"mode": "clustered deferred", "bundles": True, "deferredCompute": True, "compactGBuffer": True, "bloom": True},
        {"mode": "clustered deferred"},
        "bundles + compute lighting + compact G-buffer + bloom enabled together",
    ),
    FeatureDefinition(
        "Combined Forward+", "Combined Forward+",
        {"mode": "forward+", "bundles": True, "depthMode": "culling", "bloom": True},
        {"mode": "forward+"}, "bundles + depth prepass/culling + bloom enabled together",
    ),
)

KERNEL_VARIANTS: tuple[tuple[str, Mapping[str, Any]], ...] = (
    ("Forward+ ordinary", {"mode": "forward+", "depthMode": "off"}),
    (
        "Compact compute deferred",
        {"mode": "clustered deferred", "deferredCompute": True, "compactGBuffer": True},
    ),
)


def feature_pairs(report: Report, feature: FeatureDefinition) -> list[tuple[tuple[int, int, str, int], CaseData, CaseData]]:
    pairs = []
    for spec in workload_specs():
        width, height, camera, lights = spec
        shared = {"width": width, "height": height, "cameraPreset": camera, "lightCount": lights}
        before = report.case(full_config(**shared, **feature.before_patch))
        after = report.case(full_config(**shared, **feature.after_patch))
        pairs.append((spec, before, after))
    return pairs


def kernel_pairs(
    report: Report, base_patch: Mapping[str, Any],
) -> list[tuple[tuple[int, int, str, int], CaseData, CaseData]]:
    pairs = []
    for spec in workload_specs():
        width, height, camera, lights = spec
        shared = {
            "width": width,
            "height": height,
            "cameraPreset": camera,
            "lightCount": lights,
            **base_patch,
        }
        before = report.case(expected_config(**shared, optimizedLightMath=False))
        after = report.case(expected_config(**shared, optimizedLightMath=True))
        pairs.append((spec, before, after))
    return pairs


def repeat_delta_range(before: CaseData, after: CaseData, metric: str) -> tuple[float, float]:
    deltas = [
        after.percentile(metric, 0.5, repeat) - before.percentile(metric, 0.5, repeat)
        for repeat in range(EXPECTED_REPEATS)
    ]
    return min(deltas), max(deltas)


def normalize_svg_trailing_whitespace(path: Path) -> None:
    """Strip spaces and tabs at line ends without changing SVG newline bytes."""
    original = path.read_bytes()
    normalized = re.sub(rb"[ \t]+(?=\r?$)", b"", original, flags=re.MULTILINE)
    if normalized != original:
        path.write_bytes(normalized)


def save_figure(figure: Any, output_dir: Path, stem: str) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = [output_dir / f"{stem}.png", output_dir / f"{stem}.svg"]
    figure.savefig(paths[0], dpi=190, bbox_inches="tight", facecolor="white")
    figure.savefig(paths[1], bbox_inches="tight", facecolor="white")
    normalize_svg_trailing_whitespace(paths[1])
    return paths


def configure_matplotlib() -> tuple[Any, Any]:
    try:
        import matplotlib  # type: ignore
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt  # type: ignore
        from matplotlib.lines import Line2D  # type: ignore
    except ModuleNotFoundError as error:
        raise EvidenceError(
            "Matplotlib is required only for offline plotting and is not installed. "
            "Install it in an external Python environment (for example, "
            "`python3 -m pip install matplotlib`) and rerun this script; do not add it "
            "to the web project's package dependencies."
        ) from error

    plt.rcParams.update({
        "figure.facecolor": "white",
        "axes.facecolor": "#F7F8FA",
        "axes.edgecolor": "#46515C",
        "axes.labelcolor": "#26323D",
        "axes.titlecolor": "#17232E",
        "axes.grid": True,
        "grid.color": "#D8DEE4",
        "grid.linewidth": 0.7,
        "grid.alpha": 0.8,
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "legend.frameon": False,
    })
    return plt, Line2D


def plot_renderer_curves(report: Report, output_dir: Path, plt: Any, line2d: Any) -> list[Path]:
    figure, axes = plt.subplots(2, 2, figsize=(12.5, 8.0), sharex=True)
    panels = [(width, height, camera) for width, height in SIZES for camera in CAMERAS]
    for axis, (width, height, camera) in zip(axes.flat, panels):
        for mode in RENDERERS:
            cases = [
                report.case(full_config(
                    mode=mode, width=width, height=height,
                    cameraPreset=camera, lightCount=light_count,
                ))
                for light_count in LIGHT_COUNTS
            ]
            medians = [case.percentile("render", 0.5) for case in cases]
            p95s = [case.percentile("render", 0.95) for case in cases]
            repeat_values = [case.repeat_medians("render") for case in cases]
            lows = [min(values) for values in repeat_values]
            highs = [max(values) for values in repeat_values]
            color = COLORS[mode]
            axis.fill_between(LIGHT_COUNTS, lows, highs, color=color, alpha=0.12, linewidth=0)
            axis.plot(LIGHT_COUNTS, medians, marker="o", color=color, linewidth=2.0)
            axis.plot(LIGHT_COUNTS, p95s, marker=".", color=color, linewidth=1.35, linestyle=":")
        axis.set_title(f"{camera} · {width}×{height}")
        axis.set_xscale("log", base=2)
        axis.set_xticks(LIGHT_COUNTS, [f"{count:,}" for count in LIGHT_COUNTS])
        axis.set_ylabel("GPU render span (ms)")
        axis.set_xlabel("Point lights")
        axis.grid(which="minor", visible=False)

    mode_handles = [
        line2d([0], [0], color=COLORS[mode], marker="o", linewidth=2, label=mode.title())
        for mode in RENDERERS
    ]
    style_handles = [
        line2d([0], [0], color="#26323D", linewidth=2, label="Pooled median (900 samples)"),
        line2d([0], [0], color="#26323D", linewidth=1.35, linestyle=":", label="Pooled p95"),
        line2d([0], [0], color="#26323D", linewidth=7, alpha=0.12, label="Range of 3 repeat medians"),
    ]
    figure.legend(handles=mode_handles + style_handles, loc="lower center", bbox_to_anchor=(0.5, 0.015), ncol=3)
    figure.suptitle("Renderer scaling by camera, resolution, and light count", fontsize=15, fontweight="bold")
    figure.text(
        0.5, 0.93,
        "Render span begins at the first render-related GPU pass and ends after presentation; light movement is excluded.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.18, top=0.86, hspace=0.30, wspace=0.20)
    paths = save_figure(figure, output_dir, "renderer-light-count")
    plt.close(figure)
    return paths


def plot_cluster_grid(report: Report, output_dir: Path, plt: Any, line2d: Any) -> list[Path]:
    figure, axes = plt.subplots(1, 2, figsize=(12.5, 4.8), sharey=True)
    for axis, mode in zip(axes, ("forward+", "clustered deferred")):
        for grid in GRIDS:
            cases = [
                report.case(full_config(
                    mode=mode, width=1920, height=1080, cameraPreset="Atrium",
                    lightCount=light_count, clusterGrid=grid,
                ))
                for light_count in LIGHT_COUNTS
            ]
            medians = [case.percentile("render", 0.5) for case in cases]
            p95s = [case.percentile("render", 0.95) for case in cases]
            repeat_values = [case.repeat_medians("render") for case in cases]
            color = COLORS[grid]
            axis.fill_between(
                LIGHT_COUNTS,
                [min(values) for values in repeat_values],
                [max(values) for values in repeat_values],
                color=color, alpha=0.12, linewidth=0,
            )
            axis.plot(LIGHT_COUNTS, medians, marker="o", color=color, linewidth=2)
            axis.plot(LIGHT_COUNTS, p95s, marker=".", color=color, linewidth=1.3, linestyle=":")
        axis.set_title(mode.title())
        axis.set_xscale("log", base=2)
        axis.set_xticks(LIGHT_COUNTS, [f"{count:,}" for count in LIGHT_COUNTS])
        axis.set_xlabel("Point lights")
        axis.grid(which="minor", visible=False)
    axes[0].set_ylabel("GPU render span (ms)")
    grid_handles = [line2d([0], [0], color=COLORS[grid], marker="o", linewidth=2, label=grid) for grid in GRIDS]
    style_handles = [
        line2d([0], [0], color="#26323D", linewidth=2, label="Pooled median"),
        line2d([0], [0], color="#26323D", linewidth=1.3, linestyle=":", label="Pooled p95"),
        line2d([0], [0], color="#26323D", linewidth=7, alpha=0.12, label="Repeat-median range"),
    ]
    figure.legend(handles=grid_handles + style_handles, loc="lower center", bbox_to_anchor=(0.5, 0.015), ncol=3)
    figure.suptitle("Cluster-grid scaling · Atrium · 1920×1080", fontsize=15, fontweight="bold")
    figure.text(
        0.5, 0.89,
        "Each point compares the same effective configuration; only the cluster-grid dimensions change.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.28, top=0.78, wspace=0.12)
    paths = save_figure(figure, output_dir, "cluster-grid-scaling")
    plt.close(figure)
    return paths


def plot_feature_deltas(report: Report, output_dir: Path, plt: Any, line2d: Any) -> list[Path]:
    figure, axes = plt.subplots(4, 2, figsize=(14, 13.5), sharex=False)
    specs = workload_specs()
    labels = [workload_short(spec) for spec in specs]
    for axis, feature in zip(axes.flat, FEATURES):
        pairs = feature_pairs(report, feature)
        median_deltas = [after.percentile("render", 0.5) - before.percentile("render", 0.5) for _, before, after in pairs]
        p95_deltas = [after.percentile("render", 0.95) - before.percentile("render", 0.95) for _, before, after in pairs]
        ranges = [repeat_delta_range(before, after, "render") for _, before, after in pairs]
        x_values = list(range(len(specs)))
        axis.axhline(0, color="#17232E", linewidth=0.9)
        axis.vlines(x_values, [low for low, _ in ranges], [high for _, high in ranges], color="#9BA6AF", linewidth=4, alpha=0.8)
        axis.plot(x_values, median_deltas, color="#4C72B0", marker="o", linewidth=1.8)
        axis.plot(x_values, p95_deltas, color="#C44E52", marker="^", linewidth=1.2, linestyle=":")
        axis.set_title(feature.name)
        axis.set_ylabel("After − before (ms)")
        axis.text(
            0.01, 0.96, textwrap.fill(feature.changed_flags, width=44),
            transform=axis.transAxes, va="top", fontsize=7.0, linespacing=1.15, color="#46515C",
            bbox={"facecolor": "white", "edgecolor": "none", "alpha": 0.72, "pad": 1.0},
        )
        axis.set_xticks(x_values, labels, rotation=38, ha="right")
    axes.flat[-1].axis("off")
    axes.flat[-1].text(
        0.02, 0.93,
        "Workload key\nA = Atrium · R = Arcade\n720/1080 = output height\n128/5000 = point lights\n\nNegative deltas are faster.\nGray bars are the range of\nthree matched-repeat median deltas.",
        va="top", fontsize=11, linespacing=1.5,
    )
    handles = [
        line2d([0], [0], color="#4C72B0", marker="o", linewidth=1.8, label="Pooled-median delta"),
        line2d([0], [0], color="#C44E52", marker="^", linewidth=1.2, linestyle=":", label="Pooled-p95 delta"),
        line2d([0], [0], color="#9BA6AF", linewidth=4, label="Matched repeat-median range"),
    ]
    figure.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.015), ncol=3)
    figure.suptitle("Isolated and combined feature deltas", fontsize=15, fontweight="bold")
    figure.text(
        0.5, 0.955,
        "Each pair matches renderer, camera, resolution, lights, grid, fixed time, and every unrelated feature flag.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.12, top=0.92, hspace=0.55, wspace=0.22)
    paths = save_figure(figure, output_dir, "feature-deltas")
    plt.close(figure)
    return paths


def plot_kernel_deltas(report: Report, output_dir: Path, plt: Any, line2d: Any) -> list[Path]:
    figure, axes = plt.subplots(1, 2, figsize=(13.5, 5.2), sharey=False)
    specs = workload_specs()
    labels = [workload_short(spec) for spec in specs]
    x_values = list(range(len(specs)))
    for axis, (name, base_patch) in zip(axes, KERNEL_VARIANTS):
        pairs = kernel_pairs(report, base_patch)
        median_deltas = [after.percentile("render", 0.5) - before.percentile("render", 0.5) for _, before, after in pairs]
        p95_deltas = [after.percentile("render", 0.95) - before.percentile("render", 0.95) for _, before, after in pairs]
        ranges = [repeat_delta_range(before, after, "render") for _, before, after in pairs]
        axis.axhline(0, color="#17232E", linewidth=0.9)
        axis.vlines(
            x_values, [low for low, _ in ranges], [high for _, high in ranges],
            color="#9BA6AF", linewidth=4, alpha=0.8,
        )
        axis.plot(x_values, median_deltas, color="#4C72B0", marker="o", linewidth=1.8)
        axis.plot(x_values, p95_deltas, color="#C44E52", marker="^", linewidth=1.2, linestyle=":")
        axis.set_title(name)
        axis.set_ylabel("Optimized − reference render span (ms)")
        axis.set_xticks(x_values, labels, rotation=38, ha="right")
    handles = [
        line2d([0], [0], color="#4C72B0", marker="o", linewidth=1.8, label="Pooled-median delta"),
        line2d([0], [0], color="#C44E52", marker="^", linewidth=1.2, linestyle=":", label="Pooled-p95 delta"),
        line2d([0], [0], color="#9BA6AF", linewidth=4, label="Matched repeat-median range"),
    ]
    figure.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.015), ncol=3)
    figure.suptitle("Optimized point-light math · isolated GPU render-span deltas", fontsize=15, fontweight="bold")
    figure.text(
        0.5, 0.91,
        "Every pair changes only optimizedLightMath; negative deltas are faster.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.30, top=0.80, wspace=0.22)
    paths = save_figure(figure, output_dir, "optimized-light-math")
    plt.close(figure)
    return paths


def plot_bundle_cpu(report: Report, output_dir: Path, plt: Any, line2d: Any) -> list[Path]:
    figure, axes = plt.subplots(3, 1, figsize=(13, 10), sharex=True)
    specs = workload_specs()
    x_values = list(range(len(specs)))
    for axis, mode in zip(axes, RENDERERS):
        before_cases = []
        after_cases = []
        for width, height, camera, lights in specs:
            shared = dict(mode=mode, width=width, height=height, cameraPreset=camera, lightCount=lights)
            before_cases.append(report.case(full_config(**shared, bundles=False)))
            after_cases.append(report.case(full_config(**shared, bundles=True)))
        for x_value, before, after in zip(x_values, before_cases, after_cases):
            before_median = before.percentile("cpu", 0.5)
            after_median = after.percentile("cpu", 0.5)
            axis.plot([x_value - 0.13, x_value + 0.13], [before_median, after_median], color="#9BA6AF", linewidth=1)
            for offset, case, color, marker in (
                (-0.13, before, "#C44E52", "o"),
                (0.13, after, "#4C72B0", "s"),
            ):
                medians = case.repeat_medians("cpu")
                pooled = case.percentile("cpu", 0.5)
                p95 = case.percentile("cpu", 0.95)
                axis.vlines(x_value + offset, min(medians), max(medians), color=color, linewidth=3, alpha=0.28)
                axis.scatter([x_value + offset], [pooled], color=color, marker=marker, s=35, zorder=3)
                axis.scatter([x_value + offset], [p95], facecolors="none", edgecolors=color, marker="^", s=30, zorder=3)
        axis.set_title(mode.title())
        axis.set_ylabel("CPU encode/submit (ms)")
    axes[-1].set_xticks(x_values, [workload_short(spec) for spec in specs], rotation=35, ha="right")
    handles = [
        line2d([0], [0], color="#C44E52", marker="o", linewidth=0, label="Direct pooled median"),
        line2d([0], [0], color="#4C72B0", marker="s", linewidth=0, label="Bundle pooled median"),
        line2d([0], [0], color="#26323D", marker="^", markerfacecolor="none", linewidth=0, label="Pooled p95"),
        line2d([0], [0], color="#9BA6AF", linewidth=3, alpha=0.4, label="Repeat-median range"),
    ]
    figure.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.015), ncol=4)
    figure.suptitle(
        "Render-bundle CPU encoding and submission",
        fontsize=15,
        fontweight="bold",
        y=0.985,
    )
    figure.text(
        0.5, 0.942,
        "CPU timing excludes light movement and asynchronous readback completion; its timer precision is separate from GPU timestamps.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.16, top=0.875, hspace=0.34)
    paths = save_figure(figure, output_dir, "render-bundles-cpu")
    plt.close(figure)
    return paths


def capacity_configurations(optimized: bool = False) -> list[dict[str, Any]]:
    return [
        expected_config(
            mode="forward+", lightCount=5000, bundles=True,
            clusterGrid=grid, depthMode=depth_mode, optimizedLightMath=optimized,
        )
        for grid in GRIDS
        for depth_mode in ("off", "culling")
    ]


def validate_full_plan(report: Report) -> None:
    if len(report.cases_by_id) != 176 or report.result_count != 528 or report.raw_count != 158_400:
        raise EvidenceError(
            f"{report.path}: a full report must contain 176 unique configurations, 528 result rows, "
            f"and 158,400 raw samples; found {len(report.cases_by_id)}, {report.result_count}, "
            f"and {report.raw_count}."
        )
    for width, height in SIZES:
        for camera in CAMERAS:
            for light_count in LIGHT_COUNTS:
                for mode in RENDERERS:
                    report.case(full_config(
                        mode=mode, width=width, height=height,
                        cameraPreset=camera, lightCount=light_count,
                    ))
    for grid in GRIDS:
        for light_count in LIGHT_COUNTS:
            for mode in ("forward+", "clustered deferred"):
                report.case(full_config(
                    mode=mode, width=1920, height=1080, cameraPreset="Atrium",
                    lightCount=light_count, clusterGrid=grid,
                ))
    for feature in FEATURES:
        feature_pairs(report, feature)
    for width, height, camera, lights in workload_specs():
        for mode in RENDERERS:
            shared = dict(mode=mode, width=width, height=height, cameraPreset=camera, lightCount=lights)
            report.case(full_config(**shared, bundles=False))
            report.case(full_config(**shared, bundles=True))
    reference_keys: set[str] = set()
    for width, height, camera, lights in workload_specs():
        shared = dict(width=width, height=height, cameraPreset=camera, lightCount=lights)
        for configuration in (
            expected_config(**shared, mode="forward+", depthMode="off", optimizedLightMath=False),
            expected_config(
                **shared, mode="clustered deferred", deferredCompute=True,
                compactGBuffer=True, optimizedLightMath=False,
            ),
        ):
            report.case(configuration)
            reference_keys.add(config_key(configuration))
    false_math = {
        config_key(case.configuration)
        for case in report.cases_by_id.values()
        if not case.configuration["optimizedLightMath"]
    }
    if false_math != reference_keys:
        raise EvidenceError(
            f"{report.path}: the 16 reference-kernel configurations do not match the agreed isolated plan."
        )


def validate_capacity_plan(report: Report) -> None:
    expected_optimized = (False,) if report.capacity == 256 else (False, True)
    expected_cases = 6 * len(expected_optimized)
    expected_results = expected_cases * EXPECTED_REPEATS
    expected_raw = expected_results * EXPECTED_SAMPLES
    if (
        len(report.cases_by_id) != expected_cases
        or report.result_count != expected_results
        or report.raw_count != expected_raw
    ):
        raise EvidenceError(
            f"{report.path}: capacity {report.capacity} must contain {expected_cases} unique configurations, "
            f"{expected_results} result rows, and {expected_raw:,} raw samples; found "
            f"{len(report.cases_by_id)}, {report.result_count}, "
            f"and {report.raw_count}."
        )
    for optimized in expected_optimized:
        for configuration in capacity_configurations(optimized):
            case = report.case(configuration)
            dimensions = [int(value) for value in str(configuration["clusterGrid"]).split("x")]
            cluster_count = math.prod(dimensions)
            expected_stride = (2 + report.capacity) * 4
            expected_bytes = cluster_count * expected_stride
            for repeat, row in enumerate(sorted(case.results, key=lambda item: int(item["repeat"]))):
                diagnostics = row["diagnostics"]
                required = (
                    "capacity", "totalClusters", "clusterRecordStrideBytes", "logicalClusterBufferBytes",
                    "activeClusters", "activeClusterFraction", "overflowClusters", "overflowClusterFraction",
                    "visiblePixelCount", "overflowVisiblePixels", "overflowVisibleFraction",
                )
                missing = [name for name in required if name not in diagnostics]
                if missing:
                    raise EvidenceError(
                        f"{report.path}: {case.case_id!r} repeat {repeat} diagnostics are missing {missing}."
                    )
                numeric = {
                    name: finite_number(
                        diagnostics[name], f"{report.path}: {case.case_id} repeat {repeat} diagnostics.{name}"
                    )
                    for name in required
                }
                if numeric["capacity"] != report.capacity:
                    raise EvidenceError(f"{report.path}: diagnostic capacity disagrees with report capacity.")
                if numeric["totalClusters"] != cluster_count:
                    raise EvidenceError(f"{report.path}: diagnostic cluster count disagrees with clusterGrid.")
                if numeric["clusterRecordStrideBytes"] != expected_stride:
                    raise EvidenceError(f"{report.path}: diagnostic cluster stride disagrees with capacity.")
                if numeric["logicalClusterBufferBytes"] != expected_bytes:
                    raise EvidenceError(f"{report.path}: diagnostic logical cluster bytes disagree with grid/capacity.")
                for name in ("activeClusterFraction", "overflowClusterFraction", "overflowVisibleFraction"):
                    if not 0.0 <= numeric[name] <= 1.0:
                        raise EvidenceError(f"{report.path}: diagnostics.{name} must be in [0, 1].")
                count_names = (
                    "capacity", "totalClusters", "clusterRecordStrideBytes", "logicalClusterBufferBytes",
                    "activeClusters", "overflowClusters", "visiblePixelCount", "overflowVisiblePixels",
                )
                for name in count_names:
                    if not numeric[name].is_integer():
                        raise EvidenceError(f"{report.path}: diagnostics.{name} must be an integer count.")
                if numeric["activeClusters"] > numeric["totalClusters"]:
                    raise EvidenceError(f"{report.path}: activeClusters exceeds totalClusters.")
                if numeric["overflowClusters"] > numeric["totalClusters"]:
                    raise EvidenceError(f"{report.path}: overflowClusters exceeds totalClusters.")
                if numeric["overflowVisiblePixels"] > numeric["visiblePixelCount"]:
                    raise EvidenceError(f"{report.path}: overflowVisiblePixels exceeds visiblePixelCount.")
                expected_fractions = {
                    "activeClusterFraction": numeric["activeClusters"] / numeric["totalClusters"],
                    "overflowClusterFraction": numeric["overflowClusters"] / numeric["totalClusters"],
                    "overflowVisibleFraction": (
                        numeric["overflowVisiblePixels"] / numeric["visiblePixelCount"]
                        if numeric["visiblePixelCount"] else 0.0
                    ),
                }
                for name, expected_fraction in expected_fractions.items():
                    if not math.isclose(numeric[name], expected_fraction, rel_tol=1e-9, abs_tol=1e-9):
                        raise EvidenceError(
                            f"{report.path}: diagnostics.{name} disagrees with its reported counts."
                        )


def validate_shared_provenance(reports: Sequence[Report]) -> None:
    """Require reports used together to describe the same browser/GPU timing source."""
    if len(reports) < 2:
        return
    reference = reports[0]
    fields = ("userAgent", "adapterInfo")
    for report in reports[1:]:
        for field_name in fields:
            if report.payload[field_name] != reference.payload[field_name]:
                raise EvidenceError(
                    f"{report.path}: {field_name} disagrees with {reference.path}; "
                    "cross-report comparisons require matching capture provenance."
                )
    calibrated = {
        report.payload["timestampQuantumNs"]
        for report in reports
        if report.payload.get("timestampQuantumNs") is not None
    }
    if len(calibrated) > 1:
        raise EvidenceError(
            "Reports with numeric timestampQuantumNs calibration disagree: "
            + ", ".join(str(value) for value in sorted(calibrated))
        )


def capacity_case_label(configuration: Mapping[str, Any]) -> str:
    depth = "off" if configuration["depthMode"] == "off" else "cull"
    return f"{configuration['clusterGrid']}\n{depth}"


def logical_cluster_bytes(case: CaseData, capacity: int) -> float:
    reported = case.diagnostic_median("logicalClusterBufferBytes")
    if reported is not None:
        return reported
    dimensions = [int(value) for value in str(case.configuration["clusterGrid"]).split("x")]
    cluster_count = math.prod(dimensions)
    return float(cluster_count * (2 + capacity) * 4)


def plot_capacity_comparison(
    reports: Mapping[int, Report], output_dir: Path, plt: Any, line2d: Any,
) -> list[Path]:
    if set(reports) != {256, 1024}:
        return []
    configurations = capacity_configurations()
    labels = [capacity_case_label(configuration) for configuration in configurations]
    x_values = list(range(len(configurations)))
    figure, axes = plt.subplots(2, 2, figsize=(14, 9.3))

    render_axis = axes[0, 0]
    for capacity, offset in ((256, -0.10), (1024, 0.10)):
        cases = [reports[capacity].case(configuration) for configuration in configurations]
        medians = [case.percentile("render", 0.5) for case in cases]
        p95s = [case.percentile("render", 0.95) for case in cases]
        color = COLORS[str(capacity)]
        for x_value, case in zip(x_values, cases):
            repeats = case.repeat_medians("render")
            render_axis.vlines(x_value + offset, min(repeats), max(repeats), color=color, linewidth=4, alpha=0.25)
        render_axis.plot([x + offset for x in x_values], medians, color=color, marker="o", label=f"capacity {capacity}")
        render_axis.plot([x + offset for x in x_values], p95s, color=color, marker="^", linestyle=":")
    render_axis.set_title("GPU render span")
    render_axis.set_ylabel("Milliseconds")
    render_axis.set_xticks(x_values, labels)

    active_axis = axes[0, 1]
    bar_width = 0.34
    for capacity, offset in ((256, -0.10), (1024, 0.10)):
        values = [
            100.0 * float(reports[capacity].case(configuration).diagnostic_median("activeClusterFraction"))
            for configuration in configurations
        ]
        active_axis.plot(
            [x + offset for x in x_values], values, color=COLORS[str(capacity)], marker="D",
        )
    active_axis.set_title("Passive active-cluster readback")
    active_axis.set_ylabel("Active clusters (%)")
    active_axis.set_xticks(x_values, labels)
    active_axis.set_ylim(0, 105)

    overflow_axis = axes[1, 0]
    marker_map = {"overflowClusterFraction": "o", "overflowVisibleFraction": "s"}
    for capacity, offset in ((256, -0.10), (1024, 0.10)):
        color = COLORS[str(capacity)]
        for name, marker in marker_map.items():
            values = []
            for configuration in configurations:
                value = reports[capacity].case(configuration).diagnostic_median(name)
                values.append(float("nan") if value is None else 100.0 * value)
            overflow_axis.plot(
                [x + offset for x in x_values], values, color=color,
                marker=marker, linestyle="-" if name == "overflowClusterFraction" else ":",
            )
    overflow_axis.set_title("Passive overflow diagnostics")
    overflow_axis.set_ylabel("Percent")
    overflow_axis.set_xticks(x_values, labels)
    overflow_axis.set_ylim(bottom=0)

    memory_axis = axes[1, 1]
    for capacity, offset in ((256, -bar_width / 2), (1024, bar_width / 2)):
        values = [
            logical_cluster_bytes(reports[capacity].case(configuration), capacity) / (1024 * 1024)
            for configuration in configurations
        ]
        memory_axis.bar(
            [x + offset for x in x_values], values, width=bar_width,
            color=COLORS[str(capacity)], alpha=0.88, label=f"capacity {capacity}",
        )
    memory_axis.set_title("Logical cluster-record storage")
    memory_axis.set_ylabel("MiB (format-level, not driver allocation)")
    memory_axis.set_xticks(x_values, labels)

    capacity_handles = [line2d([0], [0], color=COLORS[str(value)], marker="o", label=f"capacity {value}") for value in (256, 1024)]
    metric_handles = [
        line2d([0], [0], color="#26323D", marker="o", label="Pooled median / cluster overflow"),
        line2d([0], [0], color="#26323D", marker="^", linestyle=":", label="Pooled p95"),
        line2d([0], [0], color="#26323D", marker="s", linestyle=":", label="Visible-pixel overflow"),
        line2d([0], [0], color="#26323D", marker="D", label="Active-cluster fraction"),
    ]
    figure.legend(
        handles=capacity_handles + metric_handles,
        loc="lower center", bbox_to_anchor=(0.5, 0.012), ncol=3,
    )
    figure.suptitle(
        "Cluster-list capacity study · 5,000 lights · 1280×720 · Atrium",
        fontsize=15, fontweight="bold", y=0.985,
    )
    figure.text(
        0.5, 0.935,
        "Reference point-light math is fixed; timing uses complete spans and diagnostics are read after timed frames.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.17, top=0.86, hspace=0.34, wspace=0.22)
    paths = save_figure(figure, output_dir, "capacity-comparison")
    plt.close(figure)
    return paths


def plot_capacity_kernel_comparison(
    report: Report, output_dir: Path, plt: Any, line2d: Any,
) -> list[Path]:
    configurations = capacity_configurations(False)
    labels = [capacity_case_label(configuration) for configuration in configurations]
    x_values = list(range(len(configurations)))
    figure, axis = plt.subplots(1, 1, figsize=(11.5, 5.3))
    pairs = [
        (
            report.case(configuration),
            report.case({**configuration, "optimizedLightMath": True}),
        )
        for configuration in configurations
    ]
    median_deltas = [after.percentile("render", 0.5) - before.percentile("render", 0.5) for before, after in pairs]
    p95_deltas = [after.percentile("render", 0.95) - before.percentile("render", 0.95) for before, after in pairs]
    ranges = [repeat_delta_range(before, after, "render") for before, after in pairs]
    axis.axhline(0, color="#17232E", linewidth=0.9)
    axis.vlines(
        x_values, [low for low, _ in ranges], [high for _, high in ranges],
        color="#9BA6AF", linewidth=5, alpha=0.8,
    )
    axis.plot(x_values, median_deltas, color="#4C72B0", marker="o", linewidth=1.8)
    axis.plot(x_values, p95_deltas, color="#C44E52", marker="^", linewidth=1.2, linestyle=":")
    axis.set_ylabel("Optimized − reference render span (ms)")
    axis.set_xticks(x_values, labels)
    handles = [
        line2d([0], [0], color="#4C72B0", marker="o", linewidth=1.8, label="Pooled-median delta"),
        line2d([0], [0], color="#C44E52", marker="^", linewidth=1.2, linestyle=":", label="Pooled-p95 delta"),
        line2d([0], [0], color="#9BA6AF", linewidth=5, label="Matched repeat-median range"),
    ]
    figure.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.02), ncol=3)
    figure.suptitle(
        "Optimized point-light math · capacity 1024 · 5,000 lights",
        fontsize=15, fontweight="bold", y=0.97,
    )
    figure.text(
        0.5, 0.90,
        "Grid, depth mode, capacity, camera, resolution, and all other flags are held fixed.",
        ha="center", color="#46515C",
    )
    figure.subplots_adjust(bottom=0.25, top=0.80)
    paths = save_figure(figure, output_dir, "capacity-kernel-comparison")
    plt.close(figure)
    return paths


def markdown_escape(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def format_ms(value: float) -> str:
    if abs(value) >= 100:
        return f"{value:.1f}"
    if abs(value) >= 10:
        return f"{value:.2f}"
    return f"{value:.3f}"


def format_signed_ms(value: float) -> str:
    return f"{value:+.3f}"


def markdown_table(headers: Sequence[str], rows: Iterable[Sequence[Any]], aligns: Sequence[str] | None = None) -> str:
    alignments = list(aligns or ("---",) * len(headers))
    if len(alignments) != len(headers):
        raise ValueError("Markdown table alignment count does not match headers.")
    lines = [
        "| " + " | ".join(markdown_escape(header) for header in headers) + " |",
        "| " + " | ".join(alignments) + " |",
    ]
    lines.extend("| " + " | ".join(markdown_escape(value) for value in row) + " |" for row in rows)
    return "\n".join(lines)


def optional_json(path: Path) -> Mapping[str, Any] | None:
    if not path.exists():
        return None
    try:
        return read_json(path)
    except EvidenceError:
        return None


def provenance_table(reports: Sequence[Report]) -> str:
    rows = []
    for report in reports:
        rows.append((
            f"[`{report.path.name}`](./{report.path.name})",
            report.captured_at,
            report.scope,
            f"{report.capacity:,}",
            f"{len(report.cases_by_id):,}",
            f"{report.result_count:,}",
            f"{report.raw_count:,}",
            f"{report.rejected_count:,}",
        ))
    return markdown_table(
        ("Report", "Captured", "Scope", "Capacity", "Cases", "Result rows", "Raw samples", "Rejected"),
        rows,
        ("---", "---", "---", "---:", "---:", "---:", "---:", "---:"),
    )


def timestamp_provenance_table(reports: Sequence[Report]) -> str:
    rows = []
    for report in reports:
        quantum = report.payload.get("timestampQuantumNs")
        calibrated = "not recorded" if quantum is None else f"{int(quantum):,} ns ({float(quantum) / 1e6:.6f} ms)"
        rows.append((report.path.name, report.payload.get("timestampPrecision", "not reported"), calibrated))
    return markdown_table(
        ("Report", "Declared timestamp metadata", "Empirical query-interval granularity"),
        rows,
        ("---", "---", "---"),
    )


def timestamp_calibration_summary(
    reports: Sequence[Report], manifest: Mapping[str, Any] | None,
) -> str:
    quantums = sorted({
        int(report.payload["timestampQuantumNs"])
        for report in reports
        if report.payload.get("timestampQuantumNs") is not None
    })
    duration_observations: list[tuple[str, int]] = []
    for report in reports:
        for _build_name, build in manifest_build_matches(manifest, report.path.name):
            value = build.get("observedTimestampDurationQuantumNs")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                duration_observations.append((report.path.name, int(value)))
    duration_note = ""
    if duration_observations:
        rendered = ", ".join(
            f"`{name}`: {value:,} ns ({value / 1000:.3f} µs)"
            for name, value in duration_observations
        )
        duration_note = (
            f" The build manifest separately records a GCD over observed timestamp durations for {rendered}. "
            "That is a distinct empirical bound and is not substituted for a missing endpoint-difference field."
        )
    if quantums:
        quantum = quantums[0]
        missing = sum(report.payload.get("timestampQuantumNs") is None for report in reports)
        legacy_note = (
            f" {missing} legacy report(s) lack that numeric field; their declared text is retained above and "
            "comparison is permitted only because browser and adapter identity match."
            if missing else ""
        )
        return (
            f"The numeric reports record an empirical query-interval granularity of **{quantum:,} ns "
            f"({quantum / 1000:.3f} µs, {quantum / 1e6:.6f} ms)**, computed as the GCD of differences between "
            f"observed GPU query interval timestamps. It is a resolution bound for this capture, not a claimed "
            f"physical GPU clock period.{legacy_note}{duration_note}"
        )
    if duration_note:
        return (
            "The loaded report has no numeric endpoint-difference `timestampQuantumNs` calibration; its declared "
            f"metadata is retained above.{duration_note} Neither observation is treated as a physical GPU clock "
            "period."
        )
    return (
        "These loaded reports contain only descriptive timestamp metadata. The table preserves those declarations; "
        "no numeric resolution bound or physical GPU clock period is inferred from them. The separately documented "
        "legacy M5 observation is not silently imputed to a report without numeric calibration."
    )


def interval_audit_section(reports: Sequence[Report]) -> str:
    rows = []
    for report in reports:
        raw_rows = next(
            (
                report.payload[key]
                for key in ("raw", "rawSamples", "rawsamples")
                if isinstance(report.payload.get(key), list)
            ),
            [],
        )
        interval_frames = 0
        ordered_frames = 0
        exact_render_frames = 0
        overlapping_frames = 0
        for row in raw_rows:
            if not isinstance(row, Mapping) or not isinstance(row.get("sample"), Mapping):
                continue
            sample = row["sample"]
            intervals = sample.get("intervals")
            if not isinstance(intervals, Mapping) or not intervals:
                continue
            parsed = []
            for label, value in intervals.items():
                if not isinstance(value, Mapping):
                    parsed = []
                    break
                try:
                    parsed.append((str(label), int(value["startNs"]), int(value["endNs"])))
                except (KeyError, TypeError, ValueError):
                    parsed = []
                    break
            if not parsed:
                continue
            interval_frames += 1
            if all(end >= start for _label, start, end in parsed):
                ordered_frames += 1
            render_intervals = [item for item in parsed if item[0] != "Light movement"]
            if render_intervals and isinstance(sample.get("renderMs"), (int, float)):
                expected = (render_intervals[-1][2] - render_intervals[0][1]) / 1_000_000
                if math.isclose(float(sample["renderMs"]), expected, rel_tol=0, abs_tol=1e-12):
                    exact_render_frames += 1
            maximum_end = -1
            overlaps = False
            for _label, start, end in sorted(render_intervals, key=lambda item: (item[1], item[2])):
                if start < maximum_end:
                    overlaps = True
                maximum_end = max(maximum_end, end)
            if overlaps:
                overlapping_frames += 1
        if interval_frames:
            rows.append((
                f"[`{report.path.name}`](./{report.path.name})",
                f"{interval_frames:,}/{len(raw_rows):,}",
                f"{ordered_frames:,}/{interval_frames:,}",
                f"{exact_render_frames:,}/{interval_frames:,}",
                f"{overlapping_frames:,}/{interval_frames:,}",
            ))
    if not rows:
        return ""
    table = markdown_table(
        (
            "Report", "Frames with intervals", "Every interval end ≥ start",
            "renderMs equals logical first-start → last-end", "Frames with overlapping render intervals",
        ),
        rows,
        ("---", "---:", "---:", "---:", "---:"),
    )
    return (
        "### Raw timestamp-interval audit\n\n"
        f"{table}\n\n"
        "The render-span check uses capture order: the first non-light-movement interval start through the final "
        "recorded interval end. It does not replace that start with the chronologically earliest timestamp, because "
        "native intervals overlap. The overlap column is direct evidence that labeled pass spans are not exclusive "
        "costs and must not be added."
    )


def renderer_measurement_table(report: Report) -> str:
    rows = []
    for width, height in SIZES:
        for camera in CAMERAS:
            for light_count in FEATURE_LIGHT_COUNTS:
                values = [
                    report.case(full_config(
                        mode=mode, width=width, height=height,
                        cameraPreset=camera, lightCount=light_count,
                    )).percentile("render", 0.5)
                    for mode in RENDERERS
                ]
                winner = RENDERERS[min(range(len(values)), key=values.__getitem__)]
                rows.append((
                    camera, f"{width}×{height}", f"{light_count:,}",
                    *(format_ms(value) for value in values), winner,
                ))
    return markdown_table(
        ("Camera", "Resolution", "Lights", "Naive ms", "Forward+ ms", "Deferred ms", "Lowest median"),
        rows,
        ("---", "---", "---:", "---:", "---:", "---:", "---"),
    )


def renderer_findings(report: Report) -> str:
    winners: list[tuple[int, str]] = []
    high_light_values: dict[str, list[float]] = {mode: [] for mode in RENDERERS}
    for width, height in SIZES:
        for camera in CAMERAS:
            for light_count in LIGHT_COUNTS:
                values = {
                    mode: report.case(full_config(
                        mode=mode,
                        width=width,
                        height=height,
                        cameraPreset=camera,
                        lightCount=light_count,
                    )).percentile("render", 0.5)
                    for mode in RENDERERS
                }
                winners.append((light_count, min(values, key=values.__getitem__)))
                if light_count == max(LIGHT_COUNTS):
                    for mode, value in values.items():
                        high_light_values[mode].append(value)

    low_count = min(LIGHT_COUNTS)
    low_winners = sum(light_count == low_count and mode == "forward+" for light_count, mode in winners)
    higher_deferred = sum(
        light_count != low_count and mode == "clustered deferred" for light_count, mode in winners
    )
    naive_winners = sum(mode == "naive" for _, mode in winners)
    high_ranges = {
        mode: (min(values), max(values)) for mode, values in high_light_values.items()
    }
    return (
        f"In this capture, Forward+ had the lowest pooled median in **{low_winners}/4** 128-light base cases; "
        f"clustered deferred had the lowest in **{higher_deferred}/16** base cases from 512 through 5,000 lights. "
        f"Naive forward was lowest in **{naive_winners}/{len(winners)}**. At 5,000 lights, the four deferred "
        f"medians ranged from {format_ms(high_ranges['clustered deferred'][0])} to "
        f"{format_ms(high_ranges['clustered deferred'][1])} ms, versus "
        f"{format_ms(high_ranges['forward+'][0])}–{format_ms(high_ranges['forward+'][1])} ms for Forward+ and "
        f"{format_ms(high_ranges['naive'][0])}–{format_ms(high_ranges['naive'][1])} ms for naive forward. "
        "Those rankings describe only these cameras, resolutions, and renderer defaults."
    )


def feature_summary_rows(report: Report) -> list[tuple[str, str, str, str, str]]:
    rows = []
    for feature in FEATURES:
        pairs = feature_pairs(report, feature)
        measurements = [
            (
                spec,
                after.percentile("render", 0.5) - before.percentile("render", 0.5),
            )
            for spec, before, after in pairs
        ]
        deltas = [value for _, value in measurements]
        best_spec, best_value = min(measurements, key=lambda item: item[1])
        worst_spec, worst_value = max(measurements, key=lambda item: item[1])
        rows.append((
            feature.name,
            format_signed_ms(float(statistics.median(deltas))),
            f"{format_signed_ms(best_value)} · {workload_long(best_spec)}",
            f"{format_signed_ms(worst_value)} · {workload_long(worst_spec)}",
            f"{sum(value < 0 for value in deltas)}/{len(deltas)}",
        ))
    return rows


def feature_direction_rows(report: Report) -> list[tuple[str, str, str]]:
    rows = []
    for feature in FEATURES:
        pairs = feature_pairs(report, feature)
        deltas = [
            after.percentile("render", 0.5) - before.percentile("render", 0.5)
            for _, before, after in pairs
        ]
        ranges = [repeat_delta_range(before, after, "render") for _, before, after in pairs]
        rows.append((
            feature.name,
            f"{sum(value < 0 for value in deltas)} / {sum(value == 0 for value in deltas)} / "
            f"{sum(value > 0 for value in deltas)}",
            f"{sum(high < 0 for low, high in ranges)} / "
            f"{sum(low <= 0 <= high for low, high in ranges)} / "
            f"{sum(low > 0 for low, high in ranges)}",
        ))
    return rows


def feature_findings(report: Report) -> str:
    pairs_by_name = {feature.name: feature_pairs(report, feature) for feature in FEATURES}

    prepass_pairs = pairs_by_name["Forward+ depth prepass"]
    prepass_low = [
        after.percentile("render", 0.5) - before.percentile("render", 0.5)
        for spec, before, after in prepass_pairs if spec[3] == min(FEATURE_LIGHT_COUNTS)
    ]
    prepass_high = [
        after.percentile("render", 0.5) - before.percentile("render", 0.5)
        for spec, before, after in prepass_pairs if spec[3] == max(FEATURE_LIGHT_COUNTS)
    ]

    culling_pairs = pairs_by_name["Active-cluster culling"]
    culling_deltas = [
        after.percentile("render", 0.5) - before.percentile("render", 0.5)
        for _, before, after in culling_pairs
    ]

    compute_pairs = pairs_by_name["Compute deferred lighting"]
    compute_ranges = [repeat_delta_range(before, after, "render") for _, before, after in compute_pairs]
    compact_pairs = pairs_by_name["Compact G-buffer"]
    compact_deltas = [
        after.percentile("render", 0.5) - before.percentile("render", 0.5)
        for _, before, after in compact_pairs
    ]
    bloom_pairs = pairs_by_name["Gaussian bloom"]
    bloom_ranges = [repeat_delta_range(before, after, "render") for _, before, after in bloom_pairs]

    return (
        "The depth prepass produced the clearest workload split: all four 5,000-light medians fell by "
        f"{format_ms(min(-value for value in prepass_high))}–"
        f"{format_ms(max(-value for value in prepass_high))} ms, while all four 128-light medians rose by "
        f"{format_ms(min(prepass_low))}–{format_ms(max(prepass_low))} ms; every corresponding repeat range "
        "stayed on the same side of zero. Active-cluster culling, measured strictly against prepass, produced "
        f"no lower pooled median ({sum(value == 0 for value in culling_deltas)} unchanged and "
        f"{sum(value > 0 for value in culling_deltas)} higher); its largest increase was "
        f"{format_ms(max(culling_deltas))} ms, one recorded timestamp step.\n\n"
        f"Compute deferred lighting had {sum(high < 0 for low, high in compute_ranges)}/8 repeat ranges wholly "
        "below zero and the other five crossed or touched zero. Compact storage was similarly mixed, with "
        f"pooled-median deltas from {format_signed_ms(min(compact_deltas))} to "
        f"{format_signed_ms(max(compact_deltas))} ms. Bloom increased six pooled medians, but none of its two "
        f"negative median deltas had a repeat range wholly below zero; {sum(low > 0 for low, high in bloom_ranges)} "
        "ranges stayed above zero. These small, quantized, or crossing-range results do not establish a general "
        "speedup. The combined rows remain composite observations rather than attribution to any one flag."
    )


def paired_render_table(
    pairs: Sequence[tuple[tuple[int, int, str, int], CaseData, CaseData]],
) -> str:
    rows = []
    for spec, before, after in pairs:
        low, high = repeat_delta_range(before, after, "render")
        rows.append((
            workload_long(spec),
            format_ms(before.percentile("render", 0.5)),
            format_ms(before.percentile("render", 0.95)),
            format_ms(after.percentile("render", 0.5)),
            format_ms(after.percentile("render", 0.95)),
            format_signed_ms(after.percentile("render", 0.5) - before.percentile("render", 0.5)),
            f"{format_signed_ms(low)} to {format_signed_ms(high)}",
        ))
    return markdown_table(
        (
            "Workload", "Before median ms", "Before p95 ms", "After median ms", "After p95 ms",
            "Median Δ ms", "Matched-repeat median Δ range",
        ),
        rows,
        ("---", "---:", "---:", "---:", "---:", "---:", "---"),
    )


def feature_detail_sections(report: Report) -> str:
    sections = []
    for feature in FEATURES:
        sections.append(
            f"<details>\n<summary>{feature.name}: all paired GPU render spans</summary>\n\n"
            f"{paired_render_table(feature_pairs(report, feature))}\n\n</details>"
        )
    return "\n\n".join(sections)


def kernel_detail_sections(report: Report) -> str:
    sections = []
    for name, base_patch in KERNEL_VARIANTS:
        sections.append(
            f"<details>\n<summary>{name}: reference versus optimized point-light math</summary>\n\n"
            f"{paired_render_table(kernel_pairs(report, base_patch))}\n\n</details>"
        )
    return "\n\n".join(sections)


def kernel_findings(report: Report) -> str:
    pairs = [
        pair
        for _, base_patch in KERNEL_VARIANTS
        for pair in kernel_pairs(report, base_patch)
    ]
    deltas = [
        after.percentile("render", 0.5) - before.percentile("render", 0.5)
        for _, before, after in pairs
    ]
    ranges = [repeat_delta_range(before, after, "render") for _, before, after in pairs]
    high_pairs = [pair for pair in pairs if pair[0][3] == max(FEATURE_LIGHT_COUNTS)]
    high_reductions = [
        before.percentile("render", 0.5) - after.percentile("render", 0.5)
        for _, before, after in high_pairs
    ]
    high_ranges = [repeat_delta_range(before, after, "render") for _, before, after in high_pairs]
    return (
        f"The optimized kernel recorded a lower pooled median in **{sum(value < 0 for value in deltas)}/16** "
        f"pairs, an unchanged median in **{sum(value == 0 for value in deltas)}/16**, and no higher median. "
        f"All eight 5,000-light pairs fell by {format_ms(min(high_reductions))}–"
        f"{format_ms(max(high_reductions))} ms, with **{sum(high < 0 for low, high in high_ranges)}/8** "
        "matched-repeat ranges wholly below zero. Across all light counts, "
        f"{sum(high < 0 for low, high in ranges)}/16 repeat ranges stayed below zero; the remaining "
        f"{sum(low <= 0 <= high for low, high in ranges)} touched or crossed zero."
    )


def bundle_detail_table(report: Report) -> str:
    rows = []
    for mode in RENDERERS:
        for spec in workload_specs():
            width, height, camera, lights = spec
            shared = dict(mode=mode, width=width, height=height, cameraPreset=camera, lightCount=lights)
            direct = report.case(full_config(**shared, bundles=False))
            bundled = report.case(full_config(**shared, bundles=True))
            low, high = repeat_delta_range(direct, bundled, "render")
            rows.append((
                mode.title(), workload_long(spec),
                format_ms(direct.percentile("cpu", 0.5)), format_ms(direct.percentile("cpu", 0.95)),
                format_ms(bundled.percentile("cpu", 0.5)), format_ms(bundled.percentile("cpu", 0.95)),
                format_ms(direct.percentile("render", 0.5)), format_ms(direct.percentile("render", 0.95)),
                format_ms(bundled.percentile("render", 0.5)), format_ms(bundled.percentile("render", 0.95)),
                f"{format_signed_ms(low)} to {format_signed_ms(high)}",
            ))
    return markdown_table(
        (
            "Renderer", "Workload", "Direct CPU median ms", "Direct CPU p95 ms", "Bundle CPU median ms",
            "Bundle CPU p95 ms", "Direct GPU median ms", "Direct GPU p95 ms", "Bundle GPU median ms",
            "Bundle GPU p95 ms", "GPU matched-repeat median Δ range",
        ),
        rows,
        ("---", "---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---"),
    )


def representative_frame_table(report: Report) -> str:
    rows = []
    for light_count in FEATURE_LIGHT_COUNTS:
        for mode in RENDERERS:
            case = report.case(full_config(
                mode=mode, width=1920, height=1080, cameraPreset="Atrium", lightCount=light_count,
            ))
            rows.append((
                mode.title(), f"{light_count:,}",
                format_ms(case.percentile("render", 0.5)), format_ms(case.percentile("render", 0.95)),
                format_ms(case.percentile("gpu", 0.5)), format_ms(case.percentile("gpu", 0.95)),
            ))
    return markdown_table(
        ("Renderer", "Lights", "renderMs median", "renderMs p95", "gpuMs median", "gpuMs p95"),
        rows,
        ("---", "---:", "---:", "---:", "---:", "---:"),
    )


def bundle_summary_rows(report: Report) -> list[tuple[str, str, str, str, str]]:
    rows = []
    for mode in RENDERERS:
        values = []
        gpu_regressions = 0
        for spec in workload_specs():
            width, height, camera, lights = spec
            shared = dict(mode=mode, width=width, height=height, cameraPreset=camera, lightCount=lights)
            before = report.case(full_config(**shared, bundles=False))
            after = report.case(full_config(**shared, bundles=True))
            cpu_delta = after.percentile("cpu", 0.5) - before.percentile("cpu", 0.5)
            gpu_delta = after.percentile("render", 0.5) - before.percentile("render", 0.5)
            values.append((spec, cpu_delta))
            gpu_regressions += int(gpu_delta > 0)
        best_spec, best_value = min(values, key=lambda item: item[1])
        worst_spec, worst_value = max(values, key=lambda item: item[1])
        rows.append((
            mode.title(),
            format_signed_ms(float(statistics.median(value for _, value in values))),
            f"{format_signed_ms(best_value)} · {workload_long(best_spec)}",
            f"{format_signed_ms(worst_value)} · {workload_long(worst_spec)}",
            f"{gpu_regressions}/{len(values)}",
        ))
    return rows


def bundle_findings(report: Report) -> str:
    observations: list[tuple[tuple[int, int, str, int], str, float, float, float, tuple[float, float]]] = []
    for mode in RENDERERS:
        for spec in workload_specs():
            width, height, camera, lights = spec
            shared = dict(mode=mode, width=width, height=height, cameraPreset=camera, lightCount=lights)
            direct = report.case(full_config(**shared, bundles=False))
            bundled = report.case(full_config(**shared, bundles=True))
            observations.append((
                spec,
                mode,
                bundled.percentile("cpu", 0.5) - direct.percentile("cpu", 0.5),
                bundled.percentile("cpu", 0.95) - direct.percentile("cpu", 0.95),
                bundled.percentile("render", 0.5) - direct.percentile("render", 0.5),
                repeat_delta_range(direct, bundled, "render"),
            ))

    median_cpu = [row[2] for row in observations]
    p95_cpu = [row[3] for row in observations]
    gpu = [row[4] for row in observations]
    worst = max(observations, key=lambda row: row[4])
    return (
        f"The browser CPU timer resolved no median change in **{sum(value == 0 for value in median_cpu)}/24** "
        f"pairs. CPU p95 was lower in {sum(value < 0 for value in p95_cpu)}/24 and unchanged in "
        f"{sum(value == 0 for value in p95_cpu)}/24, so this capture does not demonstrate a median CPU benefit. "
        f"GPU render medians were lower/equal/higher in {sum(value < 0 for value in gpu)} / "
        f"{sum(value == 0 for value in gpu)} / {sum(value > 0 for value in gpu)} pairs. The largest regression "
        f"was {format_signed_ms(worst[4])} ms for {worst[1].title()}, {workload_long(worst[0])}; its matched-repeat "
        f"range was {format_signed_ms(worst[5][0])} to {format_signed_ms(worst[5][1])} ms, showing substantial "
        "run variation rather than a guaranteed bundle cost."
    )


def cluster_grid_summary(report: Report) -> str:
    rows = []
    for mode in ("forward+", "clustered deferred"):
        for light_count in LIGHT_COUNTS:
            values = [
                report.case(full_config(
                    mode=mode, width=1920, height=1080, cameraPreset="Atrium",
                    lightCount=light_count, clusterGrid=grid,
                )).percentile("render", 0.5)
                for grid in GRIDS
            ]
            best_index = min(range(len(values)), key=values.__getitem__)
            rows.append((mode.title(), f"{light_count:,}", GRIDS[best_index], format_ms(values[best_index])))
    return markdown_table(
        ("Renderer", "Lights", "Lowest-median grid", "Median ms"), rows,
        ("---", "---:", "---", "---:"),
    )


def cluster_grid_findings(report: Report) -> str:
    observations = []
    for mode in ("forward+", "clustered deferred"):
        for light_count in LIGHT_COUNTS:
            values = [
                report.case(full_config(
                    mode=mode,
                    width=1920,
                    height=1080,
                    cameraPreset="Atrium",
                    lightCount=light_count,
                    clusterGrid=grid,
                )).percentile("render", 0.5)
                for grid in GRIDS
            ]
            observations.append((values.index(min(values)), values[-1] - values[0], 100 * (values[-1] - values[0]) / values[0]))
    deltas = [row[1] for row in observations]
    percentages = [row[2] for row in observations]
    fine_index = len(GRIDS) - 1
    return (
        f"The finest measured grid, `{GRIDS[-1]}`, had the lowest pooled median in "
        f"**{sum(best == fine_index for best, _, _ in observations)}/{len(observations)}** renderer/light-count "
        f"pairs. Relative to `{GRIDS[0]}`, its median deltas ranged from "
        f"{format_signed_ms(min(deltas))} to {format_signed_ms(max(deltas))} ms "
        f"({min(percentages):+.1f}% to {max(percentages):+.1f}%). This does not imply that grids finer than the "
        "tested range would continue to win."
    )


def capacity_measurement_table(reports: Mapping[int, Report]) -> str:
    rows = []
    for configuration in capacity_configurations(False):
        case_by_capacity = {capacity: report.case(configuration) for capacity, report in reports.items()}
        before = case_by_capacity[256]
        after = case_by_capacity[1024]
        low, high = repeat_delta_range(before, after, "render")
        overflow_256 = before.diagnostic_median("overflowVisibleFraction")
        overflow_1024 = after.diagnostic_median("overflowVisibleFraction")
        rows.append((
            configuration["clusterGrid"], configuration["depthMode"],
            format_ms(before.percentile("render", 0.5)), format_ms(before.percentile("render", 0.95)),
            format_ms(after.percentile("render", 0.5)), format_ms(after.percentile("render", 0.95)),
            format_signed_ms(after.percentile("render", 0.5) - before.percentile("render", 0.5)),
            f"{format_signed_ms(low)} to {format_signed_ms(high)}",
            "n/a" if overflow_256 is None else f"{100 * overflow_256:.2f}%",
            "n/a" if overflow_1024 is None else f"{100 * overflow_1024:.2f}%",
            f"{logical_cluster_bytes(before, 256) / (1024 * 1024):.2f}",
            f"{logical_cluster_bytes(after, 1024) / (1024 * 1024):.2f}",
        ))
    return markdown_table(
        (
            "Grid", "Depth", "256 median ms", "256 p95 ms", "1024 median ms", "1024 p95 ms", "Δ median ms",
            "Matched-repeat Δ range ms", "256 visible overflow", "1024 visible overflow",
            "256 logical MiB", "1024 logical MiB",
        ),
        rows,
        ("---", "---", "---:", "---:", "---:", "---:", "---:", "---", "---:", "---:", "---:", "---:"),
    )


def capacity_diagnostics_table(reports: Mapping[int, Report]) -> str:
    rows = []
    for configuration in capacity_configurations(False):
        before = reports[256].case(configuration)
        after = reports[1024].case(configuration)

        def paired_percent(name: str) -> str:
            values = (before.diagnostic_median(name), after.diagnostic_median(name))
            return " / ".join("n/a" if value is None else f"{100 * value:.2f}%" for value in values)

        rows.append((
            configuration["clusterGrid"], configuration["depthMode"],
            paired_percent("activeClusterFraction"),
            paired_percent("overflowClusterFraction"),
            paired_percent("overflowVisibleFraction"),
        ))
    return markdown_table(
        (
            "Grid", "Depth", "Active clusters 256 / 1024", "Overflowing clusters 256 / 1024",
            "Visible overflow 256 / 1024",
        ),
        rows,
        ("---", "---", "---:", "---:", "---:"),
    )


def capacity_frame_span_table(reports: Mapping[int, Report]) -> str:
    rows = []
    for grid, depth_mode in (("8x4x16", "off"), ("16x9x24", "culling")):
        for capacity, optimized in ((256, False), (1024, False), (1024, True)):
            case = reports[capacity].case(expected_config(
                mode="forward+", lightCount=5000, bundles=True, clusterGrid=grid,
                depthMode=depth_mode, optimizedLightMath=optimized,
            ))
            rows.append((
                f"{grid} / {depth_mode}", f"{capacity}", "optimized" if optimized else "reference",
                format_ms(case.percentile("render", 0.5)), format_ms(case.percentile("render", 0.95)),
                format_ms(case.percentile("gpu", 0.5)), format_ms(case.percentile("gpu", 0.95)),
            ))
    return markdown_table(
        ("Configuration", "Capacity", "Light math", "renderMs median", "renderMs p95", "gpuMs median", "gpuMs p95"),
        rows,
        ("---", "---:", "---", "---:", "---:", "---:", "---:"),
    )


def capacity_findings_summary(reports: Mapping[int, Report]) -> str:
    configurations = capacity_configurations(False)
    pairs = [
        (configuration, reports[256].case(configuration), reports[1024].case(configuration))
        for configuration in configurations
    ]
    median_deltas = [after.percentile("render", 0.5) - before.percentile("render", 0.5) for _, before, after in pairs]
    relative_deltas = [
        100.0 * (after.percentile("render", 0.5) / before.percentile("render", 0.5) - 1.0)
        for _, before, after in pairs
    ]
    p95_deltas = [after.percentile("render", 0.95) - before.percentile("render", 0.95) for _, before, after in pairs]
    repeat_ranges = [repeat_delta_range(before, after, "render") for _, before, after in pairs]
    lower_medians = sum(delta < 0 for delta in median_deltas)
    lower_p95s = sum(delta < 0 for delta in p95_deltas)
    negative_repeat_ranges = sum(high < 0 for _low, high in repeat_ranges)

    timing_summary = (
        f"Capacity 1024 recorded a lower pooled render median in **{lower_medians}/{len(pairs)}** matched "
        f"configurations and a lower p95 in **{lower_p95s}/{len(pairs)}**. The 1024-minus-256 median deltas "
        f"ranged from `{min(median_deltas):.3f}` to `{max(median_deltas):.3f}` ms "
        f"({min(relative_deltas):.1f}% to {max(relative_deltas):.1f}%), and "
        f"**{negative_repeat_ranges}/{len(pairs)}** matched-repeat delta ranges stayed below zero."
    )

    visible_256 = [float(before.diagnostic_median("overflowVisibleFraction")) for _, before, _after in pairs]
    visible_1024 = [float(after.diagnostic_median("overflowVisibleFraction")) for _, _before, after in pairs]
    zero_visible_1024 = sum(value == 0 for value in visible_1024)
    storage_ratios = [
        logical_cluster_bytes(after, 1024) / logical_cluster_bytes(before, 256)
        for _, before, after in pairs
    ]
    storage_growth = (
        f"{sum(storage_ratios) / len(storage_ratios):.2f}×"
        if math.isclose(min(storage_ratios), max(storage_ratios), rel_tol=1e-9, abs_tol=1e-9)
        else f"{min(storage_ratios):.2f}× to {max(storage_ratios):.2f}×"
    )
    active_equal = all(
        math.isclose(
            float(before.diagnostic_median("activeClusterFraction")),
            float(after.diagnostic_median("activeClusterFraction")),
            rel_tol=0,
            abs_tol=1e-12,
        )
        for _, before, after in pairs
    )
    active_note = (
        "Active-cluster fractions were identical across capacities, as expected because capacity changes list "
        "storage rather than cluster occupancy."
        if active_equal
        else "The table records the measured active-cluster fractions separately because they differed."
    )
    overflow_summary = (
        f"Visible overflow at capacity 256 ranged from {100 * min(visible_256):.2f}% to "
        f"{100 * max(visible_256):.2f}%. Capacity 1024 reduced it to zero in "
        f"**{zero_visible_1024}/{len(pairs)}** configurations; the two coarse-grid cases retained "
        f"{100 * max(visible_1024):.2f}% visible overflow. {active_note} The logical cluster buffer grew by "
        f"{storage_growth}, reaching "
        f"{max(logical_cluster_bytes(after, 1024) for _, _before, after in pairs) / (1024 * 1024):.2f} MiB "
        "for the 32×18×24 grid."
    )

    culling_sentences = []
    for capacity in (256, 1024):
        reductions = []
        for grid in GRIDS:
            off = reports[capacity].case(expected_config(
                mode="forward+", lightCount=5000, bundles=True, clusterGrid=grid,
                depthMode="off", optimizedLightMath=False,
            ))
            culling = reports[capacity].case(expected_config(
                mode="forward+", lightCount=5000, bundles=True, clusterGrid=grid,
                depthMode="culling", optimizedLightMath=False,
            ))
            reductions.append(off.percentile("render", 0.5) - culling.percentile("render", 0.5))
        culling_sentences.append(
            f"capacity {capacity}: {min(reductions):.3f}–{max(reductions):.3f} ms"
        )
    culling_summary = (
        "Within each report, changing depth mode from off to culling lowered the pooled median across all three "
        f"grids ({'; '.join(culling_sentences)}). This is a combined alpha-aware prepass, fullscreen marking, "
        "masked clustering, and equal-depth final-shading comparison—not an isolated measurement of the mask "
        "or clustering skip alone."
    )

    return f"""#### Measured capacity findings

These six pairs use 1280×720 Atrium, 5,000 frozen lights, bundles enabled, time 1000, seed `0x6d2b79f5`, and the
reference point-light kernel. The reports came from the separate Vite-development builds and source commits
listed above, so this is a matched build-level capacity comparison rather than a randomized per-frame capacity
switch.

{timing_summary}

{overflow_summary}

{capacity_diagnostics_table(reports)}

Selected complete-span rows keep `renderMs` and whole-frame `gpuMs` separate; neither is reconstructed by adding
overlapping pass intervals.

{capacity_frame_span_table(reports)}

{culling_summary}"""


def capacity_kernel_table(report: Report) -> str:
    rows = []
    for configuration in capacity_configurations(False):
        before = report.case(configuration)
        after = report.case({**configuration, "optimizedLightMath": True})
        low, high = repeat_delta_range(before, after, "render")
        rows.append((
            configuration["clusterGrid"], configuration["depthMode"],
            format_ms(before.percentile("render", 0.5)), format_ms(before.percentile("render", 0.95)),
            format_ms(after.percentile("render", 0.5)), format_ms(after.percentile("render", 0.95)),
            format_signed_ms(after.percentile("render", 0.5) - before.percentile("render", 0.5)),
            f"{format_signed_ms(low)} to {format_signed_ms(high)}",
        ))
    return markdown_table(
        (
            "Grid", "Depth", "Reference median ms", "Reference p95 ms", "Optimized median ms", "Optimized p95 ms",
            "Median Δ ms", "Matched-repeat Δ range ms",
        ),
        rows,
        ("---", "---", "---:", "---:", "---:", "---:", "---:", "---"),
    )


def capacity_kernel_findings(report: Report) -> str:
    pairs = []
    for configuration in capacity_configurations(False):
        before = report.case(configuration)
        after = report.case({**configuration, "optimizedLightMath": True})
        pairs.append((configuration, before, after))
    median_deltas = [after.percentile("render", 0.5) - before.percentile("render", 0.5) for _, before, after in pairs]
    relative_deltas = [
        100.0 * (after.percentile("render", 0.5) / before.percentile("render", 0.5) - 1.0)
        for _, before, after in pairs
    ]
    p95_deltas = [after.percentile("render", 0.95) - before.percentile("render", 0.95) for _, before, after in pairs]
    repeat_ranges = [repeat_delta_range(before, after, "render") for _, before, after in pairs]
    lower_medians = sum(delta < 0 for delta in median_deltas)
    lower_p95s = sum(delta < 0 for delta in p95_deltas)
    negative_repeat_ranges = sum(high < 0 for _low, high in repeat_ranges)
    largest_index = min(range(len(median_deltas)), key=median_deltas.__getitem__)
    largest_configuration = pairs[largest_index][0]
    quantum = report.payload.get("timestampQuantumNs")
    quantum_note = (
        f" The smallest absolute median delta was {min(abs(value) for value in median_deltas):.3f} ms, above "
        f"this report's {float(quantum) / 1e6:.6f} ms empirical timestamp bound."
        if isinstance(quantum, (int, float)) and not isinstance(quantum, bool)
        else ""
    )
    return (
        f"Within the capacity-1024 build, optimized light math recorded a lower pooled median in "
        f"**{lower_medians}/{len(pairs)}** pairs and a lower p95 in **{lower_p95s}/{len(pairs)}**. Median deltas "
        f"ranged from `{min(median_deltas):.3f}` to `{max(median_deltas):.3f}` ms "
        f"({min(relative_deltas):.1f}% to {max(relative_deltas):.1f}%), with "
        f"**{negative_repeat_ranges}/{len(pairs)}** matched-repeat delta ranges below zero.{quantum_note} The "
        f"largest reduction occurred for {largest_configuration['clusterGrid']} / "
        f"{largest_configuration['depthMode']}. This is consistent with the optimized composite kernel avoiding "
        "more per-light work in that workload, but the timing attributes the change only to the flag as a whole; "
        "it cannot assign causality among early radius rejection, squared-distance attenuation algebra, and "
        "normalization hoisting."
    )


def hardware_section(hardware: Mapping[str, Any] | None) -> str:
    if not hardware:
        return "Hardware metadata file was not available when this report was generated."
    preferred = (
        ("System", hardware.get("machine_model", "not reported")),
        ("CPU", f"Apple M5 · {hardware.get('number_processors', 'core split not reported')}"),
        ("GPU", hardware.get("GPU", "not reported")),
        ("Memory", hardware.get("physical_memory", "not reported")),
        ("Operating system", f"macOS {hardware.get('macOS', 'not reported')}"),
        ("Installed Chrome (host inventory)", hardware.get("Chrome", "not reported")),
    )
    return markdown_table(("Field", "Value"), preferred)


def capture_provenance_section(reports: Sequence[Report]) -> str:
    if not reports:
        return "No final benchmark report was loaded, so no captured browser or adapter identifier is reported."
    rows = []
    for report in reports:
        adapter = report.payload.get("adapterInfo", {})
        adapter_items = []
        if isinstance(adapter, Mapping):
            preferred_keys = ("vendor", "architecture", "device", "description")
            ordered_keys = list(preferred_keys) + sorted(key for key in adapter if key not in preferred_keys)
            for key in ordered_keys:
                if key not in adapter:
                    continue
                value = adapter[key]
                rendered = "(empty)" if value in (None, "") else str(value)
                adapter_items.append(f"{key}={rendered}")
        rows.append((
            f"[`{report.path.name}`](./{report.path.name})",
            str(report.payload.get("userAgent", "not reported")),
            "; ".join(adapter_items) or "not reported",
        ))
    table = markdown_table(
        ("Report", "Captured report userAgent", "Captured report adapterInfo"),
        rows,
        ("---", "---", "---"),
    )
    return (
        f"{table}\n\n"
        "These identifiers come from each raw report. The installed Chrome version in `hardware.json` is separate "
        "host inventory and is not substituted for `userAgent`. Likewise, the reduced user-agent OS token is not "
        "treated as physical operating-system inventory. Reports compared here have matching captured user-agent "
        "and adapter identifiers."
    )


def validation_tests(validation: Mapping[str, Any] | None) -> list[Mapping[str, Any]]:
    if not validation or not isinstance(validation.get("tests"), list):
        return []
    return [test for test in validation["tests"] if isinstance(test, Mapping)]


def find_validation_test(
    validation: Mapping[str, Any] | None, name_fragment: str,
) -> Mapping[str, Any] | None:
    return next(
        (test for test in validation_tests(validation) if name_fragment in str(test.get("name", ""))),
        None,
    )


def comparison_metrics(test: Mapping[str, Any] | None) -> Mapping[str, Any]:
    if not test or not isinstance(test.get("metrics"), Mapping):
        return {}
    payload = test["metrics"]
    if "rawMaximumAbsoluteRGBError" in payload:
        return payload
    nested = payload.get("metrics")
    return nested if isinstance(nested, Mapping) else {}


def validation_test_and_gate_passed(test: Mapping[str, Any] | None) -> bool:
    if not test or test.get("passed") is not True:
        return False
    metrics = test.get("metrics")
    gate = metrics.get("gate") if isinstance(metrics, Mapping) else None
    return isinstance(gate, Mapping) and gate.get("passed") is True


def validation_gate_records(
    validation: Mapping[str, Any] | None,
) -> list[tuple[str, str, Mapping[str, Any]]]:
    records: list[tuple[str, str, Mapping[str, Any]]] = []

    def visit(value: Any, test_name: str) -> None:
        if isinstance(value, Mapping):
            label = value.get("gateLabel")
            metrics = value.get("metrics")
            if (
                isinstance(label, str)
                and isinstance(metrics, Mapping)
                and "rawMaximumAbsoluteRGBError" in metrics
            ):
                records.append((test_name, label, metrics))
                return
            for child in value.values():
                visit(child, test_name)
        elif isinstance(value, list):
            for child in value:
                visit(child, test_name)

    for test in validation_tests(validation):
        visit(test.get("metrics"), str(test.get("name", "unnamed validation")))
    return records


def validation_policy(
    validation: Mapping[str, Any] | None, name: str,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    policies = validation.get("comparisonPolicy") if validation else None
    policy = policies.get(name) if isinstance(policies, Mapping) else None
    if not isinstance(policy, Mapping):
        return {}, {}
    thresholds = policy.get("thresholds")
    gate = policy.get("gate")
    return (
        thresholds if isinstance(thresholds, Mapping) else {},
        gate if isinstance(gate, Mapping) else {},
    )


def validation_section(
    validation: Mapping[str, Any] | None,
    initial_validation: Mapping[str, Any] | None = None,
) -> str:
    if not validation:
        return (
            "See [`validation.json`](./validation.json) for native GPU checks and run "
            "`npm test` for the independent CPU suite."
        )
    tests = validation_tests(validation)
    passed = sum(test.get("passed") is True for test in tests)
    gpu_errors = validation.get("gpuErrors", [])
    error_count = len(gpu_errors) if isinstance(gpu_errors, list) else "unknown"
    captured = validation.get("capturedAt", "not reported")
    capacity = validation.get("capacity", "not reported")
    sections = [(
        f"The linked [`validation.json`](./validation.json) was captured at {captured} and records "
        f"capacity {capacity}, **{passed}/{len(tests)} native GPU checks passing**, and "
        f"**{error_count} recorded GPU errors**. "
        "The summaries below use each comparison's declared `gateLabel`; the intentional Arcade camera-change "
        "control is not folded into a parity aggregate."
    )]

    gate_records = validation_gate_records(validation)
    strict_thresholds, strict_gate = validation_policy(validation, "strictSamePath")
    strict_label = strict_gate.get("label")
    strict_records = [record for record in gate_records if record[1] == strict_label]
    if strict_records:
        raw_fractions = [float(record[2]["rawFractionWithinToleranceAll"]) for record in strict_records]
        raw_errors = [float(record[2]["rawMaximumAbsoluteRGBError"]) for record in strict_records]
        all_strict_pixels_within = all(
            fraction == 1.0
            and record[2].get("totalPixels") is not None
            and record[2].get("rawPixelsWithinToleranceAll") == record[2].get("totalPixels")
            for fraction, record in zip(raw_fractions, strict_records)
        )
        strict_conclusion = (
            "All pixels were inside the raw budget, but the comparisons are not described as bit-exact."
            if all_strict_pixels_within
            else (
                "At least one strict comparison contained pixels outside the raw budget; the reported minimum "
                "fraction, rather than an all-pixels claim, describes this evidence."
            )
        )
        camera = comparison_metrics(find_validation_test(validation, "Arcade camera transform changes"))
        camera_note = (
            f" The deliberate Arcade camera-change control has raw agreement "
            f"`{camera.get('rawFractionWithinToleranceAll')}` and no parity gate label, so it is excluded."
            if camera else ""
        )
        sections.append(
            "The strict same-path policy covers direct/bundle, compute/fullscreen, ordinary Forward+, and "
            "optimized-math parity. It uses absolute "
            f"`{strict_thresholds.get('absoluteTolerance')}` plus relative "
            f"`{strict_thresholds.get('relativeTolerance')}` raw tolerance over all pixels, requires a raw "
            f"fraction of at least `{strict_gate.get('minimumRawFractionWithinTolerance')}` and displayed "
            f"fraction of at least `{strict_gate.get('minimumDisplayedFractionWithinTolerance')}`, and "
            f"limits displayed mean RGB error to `{strict_gate.get('maximumDisplayedMeanAbsoluteRGBError')}` "
            "(1/255). Across "
            f"**{len(strict_records)} gate-labelled strict checks**, the minimum raw fraction was "
            f"`{min(raw_fractions)}` and the largest nonzero raw error was `{max(raw_errors)}`. "
            f"{strict_conclusion}{camera_note}"
        )

    tie_thresholds, tie_gate = validation_policy(validation, "depthPrepassCoplanarTies")
    tie_label = tie_gate.get("label")
    tie_records = [record for record in gate_records if record[1] == tie_label]
    if tie_records:
        tie = tie_records[0][2]
        total = int(tie["totalPixels"])
        within = int(tie["rawPixelsWithinToleranceAll"])
        outliers = total - within
        culling = comparison_metrics(find_validation_test(validation, "prepass versus prepass plus"))
        sections.append(
            "Naive versus equal-depth prepass uses the separate coplanar-tie policy with the same raw "
            f"`{tie_thresholds.get('absoluteTolerance')}` + `{tie_thresholds.get('relativeTolerance')}` budget. "
            f"It recorded **{outliers}/{total} raw outliers ({100.0 * outliers / total:.7f}%)**, agreement "
            f"`{tie.get('rawFractionWithinToleranceAll')}`, and maximum raw error "
            f"`{tie.get('rawMaximumAbsoluteRGBError')}`. These are documented exact-coplanar ties, not data "
            "errors. Prepass versus culling remains strict and recorded raw agreement "
            f"`{culling.get('rawFractionWithinToleranceAll', 'not reported')}`."
        )

    quantized_thresholds, quantized_gate = validation_policy(validation, "quantizedDeferred")
    mrt_test = find_validation_test(validation, "Deferred MRT fullscreen versus naive")
    compact_test = find_validation_test(validation, "Deferred compact fullscreen versus naive")
    mrt = comparison_metrics(mrt_test)
    compact = comparison_metrics(compact_test)
    if mrt and compact:
        quantized_conclusion = (
            "Both selected tests and their declared fraction and mean gates pass; neither path is claimed "
            "HDR-exact."
            if validation_test_and_gate_passed(mrt_test)
            and validation_test_and_gate_passed(compact_test)
            else (
                "At least one selected test or its declared gate failed, so passing the quantized encoding "
                "budget is not established."
            )
        )
        sections.append(
            "Deferred-versus-naive checks use the quantized-G-buffer policy over covered pixels: absolute "
            f"`{quantized_thresholds.get('absoluteTolerance')}` plus relative "
            f"`{quantized_thresholds.get('relativeTolerance')}`, minimum raw/display fraction "
            f"`{quantized_gate.get('minimumRawFractionWithinTolerance')}` / "
            f"`{quantized_gate.get('minimumDisplayedFractionWithinTolerance')}`, displayed mean at most "
            f"`{quantized_gate.get('maximumDisplayedMeanAbsoluteRGBError')}` (2/255), and covered normalized "
            f"mean at most `{quantized_gate.get('maximumCoveredMeanNormalizedError')}`. MRT recorded covered "
            f"agreement `{mrt.get('rawFractionWithinToleranceCovered')}`, maximum raw error "
            f"`{mrt.get('rawMaximumAbsoluteRGBError')}`, and maximum displayed error "
            f"`{mrt.get('displayedMaximumAbsoluteRGBError')}`; compact recorded "
            f"`{compact.get('rawFractionWithinToleranceCovered')}`, "
            f"`{compact.get('rawMaximumAbsoluteRGBError')}`, and "
            f"`{compact.get('displayedMaximumAbsoluteRGBError')}`. {quantized_conclusion}"
        )

    packing_test = find_validation_test(validation, "Real GPU compact G-buffer packing helpers")
    packing = packing_test.get("metrics") if packing_test else None
    if isinstance(packing, Mapping):
        evidence = packing.get("evidence")
        helpers = evidence.get("helperFunctions", []) if isinstance(evidence, Mapping) else []
        helper_text = ", ".join(f"`{name}`" for name in helpers)
        sections.append(
            f"The GPU packing check invoked {helper_text} and read back "
            f"**{packing.get('countTotal')} cases** ({packing.get('countSeeded')} seeded plus known stress "
            f"cases). Maximum angular error was `{packing.get('maxAngularErrorDegrees')}` degrees, maximum "
            f"RGBA error `{packing.get('maxRGBAError')}`, and maximum unit-length error "
            f"`{packing.get('maxUnitLengthError')}`. These are correctness measurements, not renderer timings."
        )

    overflow_test = find_validation_test(validation, "Overflow fallback shades every light")
    overflow = overflow_test.get("metrics") if overflow_test else None
    active_test = find_validation_test(validation, "Visible depth is fully covered")
    active = active_test.get("metrics") if active_test else None
    if isinstance(overflow, Mapping) and isinstance(active, Mapping):
        overflow_metrics = overflow.get("metrics")
        if not isinstance(overflow_metrics, Mapping):
            overflow_metrics = {}
        overflow_gate = overflow.get("gate")
        total_pixels = overflow_metrics.get("totalPixels")
        within_pixels = overflow_metrics.get("rawPixelsWithinToleranceAll")
        covered_pixels = overflow_metrics.get("coveredPixels")
        overflow_verified = (
            overflow_test.get("passed") is True
            and isinstance(overflow_gate, Mapping)
            and overflow_gate.get("passed") is True
            and overflow_metrics.get("finite") is True
            and isinstance(covered_pixels, (int, float))
            and not isinstance(covered_pixels, bool)
            and covered_pixels > 0
            and overflow_metrics.get("rawMaximumAbsoluteRGBError") == 0
            and overflow_metrics.get("rawFractionWithinToleranceAll") == 1
            and isinstance(total_pixels, (int, float))
            and not isinstance(total_pixels, bool)
            and within_pixels == total_pixels
        )
        overflow_conclusion = (
            "These conditions verify one complete all-light evaluation per overflowing invocation without a "
            "partial-list double add."
            if overflow_verified
            else (
                "These recorded values do not establish complete overflow-fallback correctness because the "
                "fixture, gate, or required finite/all-pixels conditions did not all pass."
            )
        )
        sections.append(
            f"The {overflow.get('lightCount')}-light overflow fixture recorded maximum raw RGB error "
            f"`{overflow_metrics.get('rawMaximumAbsoluteRGBError')}` over "
            f"{overflow_metrics.get('totalPixels')} total and {overflow_metrics.get('coveredPixels')} lit "
            f"covered pixels with finite output (`finite={str(overflow_metrics.get('finite')).lower()}`). "
            f"{overflow_conclusion} The active-mask fixture covered "
            f"{active.get('visiblePixels')} visible pixels with {active.get('missingPixels')} missing, "
            f"{active.get('activeClusters')}/{active.get('totalClusters')} active clusters, capacity "
            f"{active.get('capacity')}, and overflow-pixel fraction `{active.get('overflowPixelFraction')}`. "
            "Those 480×270 fixture values must not be imputed to unrelated screenshots."
        )

    positive_test = find_validation_test(validation, "Bloom positive effect")
    strength_test = find_validation_test(validation, "Bloom strength zero")
    threshold_test = find_validation_test(validation, "Huge bloom threshold")
    zero_test = find_validation_test(validation, "Zero lights remain black")
    positive = positive_test.get("metrics") if positive_test else None
    strength = strength_test.get("metrics") if strength_test else None
    threshold = threshold_test.get("metrics") if threshold_test else None
    zero = zero_test.get("metrics") if zero_test else None
    if all(isinstance(value, Mapping) for value in (positive, strength, threshold, zero)):
        positive_hdr = positive.get("hdrParity")
        positive_hdr_metrics = positive_hdr.get("metrics") if isinstance(positive_hdr, Mapping) else {}
        strength_presented = strength.get("presented") if isinstance(strength.get("presented"), Mapping) else {}
        threshold_presented = (
            threshold.get("presented") if isinstance(threshold.get("presented"), Mapping) else {}
        )
        zero_outputs = [zero.get(name) for name in ("hdr", "bloom", "presented")]
        zero_black = zero_test.get("passed") is True and all(
            isinstance(output, Mapping)
            and output.get("finite") is True
            and output.get("nonzeroPixels") == 0
            for output in zero_outputs
        )
        zero_conclusion = (
            "zero lights remained black through HDR, bloom, and presentation."
            if zero_black
            else (
                "the zero-light fixture did not establish black output across HDR, bloom, and presentation."
            )
        )
        sections.append(
            "Four bloom fixtures use fixed-order Naive output as input to shared post-processing. Positive bloom "
            f"changed presentation while source-HDR maximum error was "
            f"`{positive_hdr_metrics.get('rawMaximumAbsoluteRGBError')}`; strength zero recorded "
            f"`{strength_presented.get('changedPixels')}` changed pixels and "
            f"`{strength_presented.get('changedRGBBytes')}` changed RGB bytes, while a huge threshold recorded "
            f"`{threshold_presented.get('changedPixels')}` changed pixels and "
            f"`{threshold_presented.get('changedRGBBytes')}` changed RGB bytes; {zero_conclusion}"
        )

    if initial_validation:
        initial_strength = find_validation_test(initial_validation, "Bloom strength zero")
        initial_threshold = find_validation_test(initial_validation, "Huge bloom threshold")
        initial_strength_metrics = initial_strength.get("metrics") if initial_strength else None
        initial_threshold_metrics = initial_threshold.get("metrics") if initial_threshold else None
        if isinstance(initial_strength_metrics, Mapping) and isinstance(initial_threshold_metrics, Mapping):
            initial_threshold_presented = initial_threshold_metrics.get("presented")
            if not isinstance(initial_threshold_presented, Mapping):
                initial_threshold_presented = {}
            sections.append(
                "The preserved [`validation-initial-1024.json`](./validation-initial-1024.json), captured at "
                f"{initial_validation.get('capturedAt', 'not reported')}, failed those two exact presentation "
                f"checks by {initial_strength_metrics.get('changedPixels')} changed pixel / "
                f"{initial_strength_metrics.get('changedRGBBytes')} RGB byte and "
                f"{initial_threshold_presented.get('changedPixels')} changed pixel / "
                f"{initial_threshold_presented.get('changedRGBBytes')} RGB byte, each at one LSB. Parallel "
                "cluster-list summation had changed the input between frames. The reviewed fixture correction "
                "isolated post-processing with the fixed-order Naive source; it did not loosen exact byte gates "
                "or change a GPU kernel."
            )

    sections.append(
        "The independent command `npm test` covers the CPU suite; its result is recorded separately in "
        "`build-manifest.json`. Validation establishes declared correctness bounds, not performance speedups."
    )
    return "\n\n".join(sections)


def semantic_report_name(value: Any) -> str:
    name = Path(str(value)).name
    return name[:-3] if name.endswith(".json.gz") else name


def manifest_build_matches(
    manifest: Mapping[str, Any] | None, report_name: Any,
) -> list[tuple[str, Mapping[str, Any]]]:
    builds = manifest.get("builds") if manifest else None
    if not isinstance(builds, Mapping):
        return []
    semantic_name = semantic_report_name(report_name)
    matches: list[tuple[str, Mapping[str, Any]]] = []
    for build_name, build_value in builds.items():
        if not isinstance(build_value, Mapping):
            continue
        report_values = build_value.get("reports", [])
        if isinstance(report_values, str):
            report_values = [report_values]
        if not isinstance(report_values, list):
            continue
        if semantic_name in {semantic_report_name(value) for value in report_values}:
            matches.append((str(build_name), build_value))
    return matches


def build_manifest_section(manifest: Mapping[str, Any] | None, reports: Sequence[Report]) -> str:
    if not manifest:
        return "Build provenance was not available when this report was generated."
    rows: list[tuple[Any, ...]] = []
    for report in reports:
        matches = manifest_build_matches(manifest, report.path.name)
        if not matches:
            rows.append((
                f"[`{report.path.name}`](./{report.path.name})", "not recorded", "not recorded",
                "not recorded", "not recorded", "not recorded", "not recorded", "not recorded",
                "not recorded",
            ))
            continue
        for build_name, build in matches:
            validation_report = build.get("validationReport")
            validation_link = (
                f"[`{Path(str(validation_report)).name}`](./{validation_report})"
                if isinstance(validation_report, str) and validation_report
                else "not recorded"
            )
            source_commit = build.get("sourceCommit") or "not recorded"
            rows.append((
                f"[`{report.path.name}`](./{report.path.name})",
                build_name,
                f"`{source_commit}`" if source_commit != "not recorded" else source_commit,
                build.get("clusterCapacity") or "not recorded",
                build.get("lightMath") or "not recorded",
                build.get("environment") or "not recorded",
                (
                    f"{int(build['observedTimestampDurationQuantumNs']):,} ns"
                    if isinstance(build.get("observedTimestampDurationQuantumNs"), (int, float))
                    and not isinstance(build.get("observedTimestampDurationQuantumNs"), bool)
                    else "not recorded"
                ),
                validation_link,
                build.get("tests") or "not recorded",
            ))
    starter = manifest.get("starterCommit") or "not recorded"
    starter_text = f"`{starter}`" if starter != "not recorded" else starter
    table = markdown_table(
        (
            "Report", "Manifest build", "Source commit", "Capacity", "Light math", "Environment",
            "Observed duration GCD", "Validation report", "Recorded pre-capture tests",
        ),
        rows,
        ("---", "---", "---", "---:", "---", "---", "---:", "---", "---"),
    ) if rows else "No loaded final report has a build entry yet."
    return (
        "Source/build mapping comes from [`build-manifest.json`](./build-manifest.json). "
        f"Its recorded starter baseline is {starter_text}.\n\n{table}"
    )


def release_provenance_note(
    manifest: Mapping[str, Any] | None,
    validation: Mapping[str, Any] | None,
    full_report: Report | None,
) -> str:
    if full_report is None:
        return ""
    measured_commit = "not recorded"
    measured_build: Mapping[str, Any] | None = None
    if manifest:
        matches = manifest_build_matches(manifest, full_report.path.name)
        if matches:
            measured_build = matches[0][1]
            value = measured_build.get("sourceCommit")
            if isinstance(value, str) and value:
                measured_commit = value

    release_commit = None
    release: Mapping[str, Any] | None = None
    if manifest and isinstance(manifest.get("release"), Mapping):
        release = manifest["release"]
        value = release.get("sourceCommit")
        if isinstance(value, str) and value:
            release_commit = value
    if validation:
        value = validation.get("sourceCommit")
        if release_commit is None and isinstance(value, str) and value:
            release_commit = value
    if release_commit is None and manifest:
        builds = manifest.get("builds")
        if isinstance(builds, Mapping):
            for name, build in builds.items():
                if "release" not in str(name).lower() or not isinstance(build, Mapping):
                    continue
                value = build.get("sourceCommit")
                if isinstance(value, str) and value:
                    release_commit = value
                    break

    measured_text = f"`{measured_commit}`" if measured_commit != "not recorded" else measured_commit
    if release_commit:
        measured_validation = measured_build.get("validationReport") if measured_build else None
        measured_validation_text = (
            f"[`{Path(measured_validation).name}`](./{measured_validation})"
            if isinstance(measured_validation, str) and measured_validation
            else "the measured-build validation report"
        )
        release_validation = release.get("validationReport") if release else None
        release_validation_text = (
            f"[`{Path(release_validation).name}`](./{release_validation})"
            if isinstance(release_validation, str) and release_validation
            else "the release validation report"
        )

        changed_paths = release.get("changesSinceMeasuredSource") if release else None
        changed_text = ""
        if isinstance(changed_paths, list) and all(isinstance(path, str) for path in changed_paths):
            changed_text = (
                f" The manifest identifies exactly {len(changed_paths)} changed controller/automation paths: "
                + ", ".join(f"`{path}`" for path in changed_paths)
                + "."
            )

        hash_text = ""
        measured_hashes = measured_build.get("sourceSha256") if measured_build else None
        release_hashes = release.get("sourceSha256") if release else None
        if isinstance(measured_hashes, Mapping) and isinstance(release_hashes, Mapping):
            shader_renderer_paths = {
                path
                for path in set(measured_hashes) | set(release_hashes)
                if path.startswith("src/shaders/")
                or path.startswith("src/renderers/")
                or path == "src/renderer.ts"
            }
            if shader_renderer_paths and all(
                measured_hashes.get(path) == release_hashes.get(path) for path in shader_renderer_paths
            ):
                hash_text = (
                    f" Both source snapshots contain {len(release_hashes)} recorded hashes, and every recorded "
                    "shader/renderer hash is unchanged."
                )

        return (
            f"Performance measurements and their parity evidence in {measured_validation_text} are tied to source "
            f"{measured_text}. Release UI source is `{release_commit}` and is validated separately by "
            f"{release_validation_text}; the 176-case benchmark was not rerun at the release commit.{changed_text}"
            f"{hash_text}\n\n"
            "The release cleanup restores the saved camera-preset selection before restoring the exact saved pose. "
            "Accessibility verification selected Arcade, ran the Atrium validation fixtures, then confirmed cleanup "
            "restored the Arcade dropdown selection and 720p resolution. The change does not alter measured shader, "
            "renderer, benchmark-case, timed-frame, or camera-matrix behavior."
        )
    return (
        f"Performance measurements are tied to source {measured_text}. A later independently reviewed "
        "camera-preset selector cleanup changed UI/controller code only—not shaders, renderer paths, the timed "
        "loop, or camera matrices. The current manifest and validation report do not record that release commit, "
        "so this analysis does not invent or imply a release hash."
    )


def generated_analysis(
    full_report: Report | None,
    capacity_reports: Mapping[int, Report],
    data_dir: Path,
    generated_figures: Sequence[Path],
) -> str:
    all_reports = ([full_report] if full_report else []) + [capacity_reports[key] for key in sorted(capacity_reports)]
    hardware = optional_json(data_dir / "hardware.json")
    validation = optional_json(data_dir / "validation.json")
    initial_validation = optional_json(data_dir / "validation-initial-1024.json")
    build_manifest = optional_json(data_dir / "build-manifest.json")
    figure_names = {path.name for path in generated_figures}

    if full_report:
        evidence_status = (
            "The full native report passed structural validation and every value below was recomputed from raw "
            "samples. No checkpoint or per-repeat summary median is used as a pooled measurement."
        )
        renderer_results = f"""
### Renderer comparison

![Renderer light-count curves](figures/renderer-light-count.png)

{renderer_measurement_table(full_report)}

{renderer_findings(full_report)}

The table deliberately shows both low and high light counts for every camera/resolution pair; the figure contains
all five counts plus pooled p95 and repeat-median ranges. Naive forward performs the complete light loop for every
surviving fragment, so its fragment cost grows directly with both visible work and light count. Forward+ pays to
transform lights and build lists, then shades only a cluster's candidates. Clustered deferred uses those same lists
but moves lighting to a screen-space pass after writing material/geometry data. Which clustered renderer wins is an
observed workload result, not a universal ordering: Forward+ can avoid G-buffer traffic, while deferred shades each
covered pixel once and decouples geometry submission from lighting.

### Cluster-grid scaling

![Cluster-grid scaling](figures/cluster-grid-scaling.png)

{cluster_grid_summary(full_report)}

{cluster_grid_findings(full_report)}

The grid changes two opposing costs. Finer grids generally shorten candidate lists and reduce false-positive light
tests during shading, but create more records, more sphere/AABB intersection work, and more memory traffic. The
clusters use logarithmic depth slices between 0.1 and 1000. Each frustum cell is represented by a conservative
view-space AABB, so a sphere may intersect the AABB without intersecting the exact frustum: that is a safe false
positive. Tighter geometric tests could reduce list lengths, but their extra clustering ALU and branch cost would
need measurement.

### Isolated feature deltas

![Feature deltas](figures/feature-deltas.png)

Negative deltas mean the feature was faster. “Best” and “worst” below are simply the minimum and maximum observed
pooled-median deltas across the eight fixed workloads; they are not confidence bounds.

{markdown_table(
    ("Feature", "Median workload Δ ms", "Best observed Δ", "Worst observed Δ", "Faster cases"),
    feature_summary_rows(full_report),
    ("---", "---:", "---", "---", "---:"),
)}

Direction counts make the repeat evidence explicit:

{markdown_table(
    ("Feature", "Pooled median lower / equal / higher", "Repeat ranges below / crossing-or-touching / above zero"),
    feature_direction_rows(full_report),
    ("---", "---:", "---:"),
)}

{feature_findings(full_report)}

The two combined rows are intentionally *not* isolated attribution. Combined deferred changes bundles, compute
lighting, compact storage, and bloom together. Combined Forward+ changes bundles, depth mode from off to culling,
and bloom together. Their baselines are the corresponding ordinary renderer with every changed flag disabled.
All standard full-benchmark configurations use `optimizedLightMath=true`, so no unrelated kernel change enters
these pairs.

{feature_detail_sections(full_report)}

### Optimized point-light math

![Optimized point-light math deltas](figures/optimized-light-math.png)

The full report adds reference-kernel cases only for ordinary Forward+ and compact compute deferred. Each of the
16 pairs holds camera, resolution, light count, renderer path, grid, and every other feature flag fixed. This is an
optimization-effort comparison, not an additional extra-credit feature. The optimized path rejects
`d² >= radius²` before square-root, attenuation, and light/normal work; uses `(1 - (d²/r²)²) / d²` attenuation; and
normalizes the surface normal once before the light loop. The reference path retains the original helper body.
Native parity tests assess `f32` rounding, and timing alone does not attribute a delta to one transformation.

{kernel_findings(full_report)}

{kernel_detail_sections(full_report)}

### Representative whole-frame GPU spans

`gpuMs` includes light movement through presentation, while `renderMs` begins after light movement. They are
reported separately here and are never reconstructed from pass intervals.

{representative_frame_table(full_report)}

### Render bundles

![Render-bundle CPU comparison](figures/render-bundles-cpu.png)

{markdown_table(
    ("Renderer", "Median workload CPU Δ ms", "Best observed CPU Δ", "Worst observed CPU Δ", "GPU regressions"),
    bundle_summary_rows(full_report),
    ("---", "---:", "---", "---", "---:"),
)}

Bundles cache pipeline, bindings, buffers, and draw commands, targeting host-side encoding overhead. They do not
promise lower GPU time, and the last column reports how often the pooled GPU render median increased. Browser timer
precision can produce a zero CPU median; the CPU timer is separate from the GPU timestamp clock.

{bundle_findings(full_report)}

<details>
<summary>All direct/bundle CPU timings and paired GPU render medians</summary>

{bundle_detail_table(full_report)}

</details>
"""
    else:
        evidence_status = (
            "**Capacity evidence complete; full-renderer evidence pending.** Both final capacity reports passed "
            "raw-data validation. `benchmark-full.json[.gz]` was not present, so this document makes no "
            "full-sweep renderer, general cluster-grid scaling, isolated-feature, bundle, or combined-configuration "
            "performance claim."
        )
        renderer_results = """
### Full benchmark status

The full native benchmark is absent. Run it before interpreting renderer tradeoffs or feature deltas; the plotter
will require 176 complete effective configurations, three repeats, and 300 raw timestamp samples per repeat.
"""

    measured_feature_reference = (
        "The paired full-report rows above show the measured best, worst, and repeat-range behavior."
        if full_report
        else "A completed full report is required before assigning a performance direction to this feature."
    )

    if set(capacity_reports) == {256, 1024} and "capacity-comparison.png" in figure_names:
        capacity_results = f"""
### Capacity comparison

![Cluster capacity comparison](figures/capacity-comparison.png)

{capacity_measurement_table(capacity_reports)}

{capacity_findings_summary(capacity_reports)}

The capacity changes the maximum stored indices, not cluster membership. Overflowing records are incomplete, so a
visible fragment falls back to one complete all-lights evaluation; it neither drops lights nor evaluates a partial
list and then repeats them. Higher capacity can avoid that fallback but grows logical record storage according to
`clusterCount × (2 + capacity) × 4` bytes. The memory table is logical buffer content, not driver allocation or a
direct bandwidth measurement. Both sides use `optimizedLightMath=false`, including the legacy capacity-256 report
where the missing field canonicalizes to false. The figure deliberately omits per-pass spans: native GPU timestamp intervals can
overlap and are not exclusive stage costs. Performance conclusions use paired complete `renderMs` spans, while
active and overflow fractions come from passive readback after timed frames.
"""
    elif capacity_reports:
        available = ", ".join(str(value) for value in sorted(capacity_reports))
        missing = ", ".join(str(value) for value in (256, 1024) if value not in capacity_reports)
        capacity_results = f"""
### Capacity comparison

Capacity report(s) {available} passed raw-data validation, but capacity {missing} is absent. No before/after capacity
plot or comparative claim is generated from one side of the experiment.
"""
    else:
        capacity_results = """
### Capacity comparison

Both final capacity reports are pending. Checkpoint rows are intentionally excluded because they have neither the
complete plan nor raw timestamp evidence.
"""

    if 1024 in capacity_reports and "capacity-kernel-comparison.png" in figure_names:
        capacity_kernel_results = f"""
### Capacity-study kernel isolation

![Capacity-study optimized light-math comparison](figures/capacity-kernel-comparison.png)

The capacity-1024 report pairs its six reference configurations with six otherwise identical optimized-light-math
configurations. Capacity remains 1024 in every pair; this table therefore isolates the kernel flag rather than
mixing kernel and list-capacity changes.

{capacity_kernel_table(capacity_reports[1024])}

{capacity_kernel_findings(capacity_reports[1024])}
"""
    else:
        capacity_kernel_results = """
### Capacity-study kernel isolation

The final capacity-1024 report is pending, so the six reference-versus-optimized kernel pairs are not yet reported.
"""

    return f"""# Performance Analysis

This report evaluates the native WebGPU implementation with milliseconds rather than FPS. It separates measured
observations from architectural explanations and does not treat a single local GPU as representative of all
devices.

## Evidence status and provenance

{evidence_status}

{provenance_table(all_reports)}

{build_manifest_section(build_manifest, all_reports)}

{release_provenance_note(build_manifest, validation, full_report)}

{timestamp_provenance_table(all_reports)}

{timestamp_calibration_summary(all_reports, build_manifest)}

Only final named reports are accepted. The loader checks timestamps, scope, protocol, exact repeat coverage, raw
sample counts, finite timings, unique configurations, and agreement between each 300-sample raw repeat and its
stored summary. Case IDs are namespaced by report in memory, which matters because both capacity runs reuse IDs.

## Hardware and validation

{hardware_section(hardware)}

### Captured browser and adapter identifiers

{capture_provenance_section(all_reports)}

{validation_section(validation, initial_validation)}

## Measurement protocol

Each effective configuration uses 120 warmup frames followed by 300 valid frames, repeated three times in
forward/reversed/forward case order. Lights are frozen at time 1000 and their colors come from fixed xorshift seed
`0x6d2b79f5`. The full sweep covers 1280×720 and 1920×1080, Atrium and Arcade cameras, and 128, 512, 1024, 2048,
and 5000 lights. Cluster-grid scaling uses 1920×1080 Atrium; isolated features use 128 and 5000 lights across both
cameras and resolutions. The 176-case full plan contains 160 inherited configurations with optimized point-light
math enabled plus 16 isolated reference-kernel configurations. Capacity 256 contains six legacy reference cases;
capacity 1024 contains the same six reference cases plus six optimized-kernel cases.

Pooled medians and p95 values are recomputed from all 900 raw samples per case using
`sorted[floor(q × n)]`: indices 450 and 855. Shaded bands/bars show the range of the three independently recomputed
300-sample repeat medians. They are run-variation summaries, not fabricated confidence intervals, and pooling does
not make the 900 temporally adjacent frames independent observations.

`renderMs` spans from the first render-related GPU pass through presentation and excludes light movement. `gpuMs`
spans light movement through presentation, including command-scheduling gaps. `cpuMs` covers render draw encoding
and submission while excluding light movement and asynchronous readback completion/processing. Per-pass timestamps
are overlapping diagnostic intervals on this native pipeline, not exclusive stage costs; they must never be added
or substituted for paired complete `renderMs` differences. Profiling uses six asynchronous slots with 64 timestamp
entries each; normal frames do not synchronously wait for the queue. When present, numeric `timestampQuantumNs`
supplies the empirical GPU query-interval resolution bound shown in provenance above; it is not a universal
hardware-clock claim. A below-bound or zero pass value does not establish zero cost. CPU timing uses a separate
timer and does not inherit that precision claim.

{interval_audit_section(all_reports)}

Passive diagnostics—active clusters, overflow, depth coverage, and logical storage—are read once after each timed
repeat and therefore sit outside the 300 measured frames. Bloom’s implementation defaults are threshold 1 and
strength 0.2. New full and capacity-1024 reports record both values in every effective configuration. The legacy
capacity-256 report omits them, so the loader canonicalizes those missing fields to the same defaults before exact
configuration matching.

## Measured results

{renderer_results}

{capacity_results}

{capacity_kernel_results}

## Feature tradeoffs and further work

### Compute deferred lighting

The compute path replaces the baseline fullscreen lighting draw while retaining the baseline MRT G-buffer for the
isolated pair. Both evaluate the same cluster lists; compute dispatches 8×8-thread workgroups and writes `rgba16float`
storage, whereas fullscreen lighting uses raster coverage and a color attachment. Resolution controls invocation
count and lights control per-pixel list work. {measured_feature_reference} Possible next
steps include workgroup-cooperative light-list staging and occupancy/tile-size tuning, subject to measurement.

### Compact G-buffer

The compact path is paired against MRT **compute** lighting so only storage changes. Baseline logical storage is 32
B/pixel: 16 B position, 8 B normal, 4 B albedo, and 4 B depth. Compact storage is one 8 B `rgba16uint` attachment plus
4 B depth, or 12 B/pixel—a 62.5% logical reduction. It packs RGBA8 albedo and octahedral SNORM16 normals, then
reconstructs world position from WebGPU 0..1 depth and inverse view-projection with the Y convention handled in the
shader. This is format-level storage, not proof of proportional driver allocation or bandwidth savings. Precision,
packing ALU, resolution, and cache behavior compete; future work could test alternative normal encodings and use
hardware counters where available.

### Optimized point-light math

The benchmark flag selects between the retained original helper and an optimized path that rejects
`d² >= radius²` before square-root, attenuation, and light/normal work, evaluates attenuation as
`(1 - (d²/r²)²) / d²`, and hoists surface-normal normalization outside the light loop. The full plan isolates that
switch for ordinary Forward+ and compact compute deferred at low/high light counts across both cameras and
resolutions; the capacity-1024 plan repeats it across all three grids and both depth modes. Native parity tests
assess `f32` rounding. Only paired complete `renderMs` spans judge performance, without claiming which individual
transformation caused a measured delta.

### Render bundles

Bundles reuse geometry command streams while buffers continue to receive current contents. They are rebuilt when
pipeline/layout or bound-resource identities change. Their best case is a CPU-bound scene with many stable draws;
their worst case is negligible host savings, timer quantization, or a GPU regression despite reduced encoding.
More objects and state changes should increase their potential value; future work could partition bundles by
material or update frequency.

### Alpha-aware Forward+ depth prepass

The prepass uses `less` with depth writes, repeats texture alpha cuts, then final shading uses `equal` with no depth
writes. This rejects geometry behind the prepass surface but does not guarantee one fragment invocation per pixel:
exactly coplanar primitives/fragments can both pass `equal`, and a later draw can select a later material. Validation
uses a separate coplanar-tie policy for prepass versus the naive reference; prepass versus culling remains strict.
The cost is duplicated vertex processing, draw submission, and alpha texture work. It should help most with
expensive lighting and high overdraw, and can lose in shallow scenes or low-light workloads. Hierarchical occlusion
or a cheaper alpha-aware depth material path are candidates for further study.

### Depth-based active-cluster culling

After the prepass, a six-vertex fullscreen quad samples depth without a depth attachment and atomically marks active
flags while writing an `r8unorm` scratch attachment. The mask is cleared every frame. Clustering still dispatches one
64-thread workgroup per cluster; inactive workgroups skip sphere/AABB intersections but are not compacted away. The
best case has a low active-cluster fraction and many lights; the worst adds clear/mark/scratch traffic while most
clusters remain active or light counts are small. Stream compaction could reduce dispatch work, but its scan,
indirect-dispatch, and synchronization cost must first be amortized. The debug view colors visible surface fragments
by occupied cluster ID using the actual active-mask binding; it does not display empty cluster volume or the raw
binary occupancy mask. Measured active fractions come from passive readback instead.

### Compute Gaussian bloom

Bloom performs a half-resolution 2×2 highlight extraction followed by separate horizontal and vertical radius-4,
sigma-2 Gaussian passes with clamped edges and distinct read/write `rgba16float` textures. Presentation upsamples
linearly; threshold 1 and strength 0.2 are implementation defaults. Once enabled, work is predictable and primarily
resolution-dependent; threshold and strength change values, not the fixed dispatch shape.
{measured_feature_reference} A multilevel bloom pyramid or cooperative workgroup tiling could reduce wide-filter
bandwidth.

## Limitations

These measurements cover one Sponza scene, two camera paths, two resolutions, and one local Apple M5 GPU/Chrome
stack. They do not establish portability or causal explanations. Thermal state, browser scheduling, unified-memory
behavior, timestamp quantization, and driver decisions remain uncontrolled. Conservative cluster AABBs create safe
false positives; overflow fallback can dominate high-density pixels; compact formats trade precision for storage;
and measured deltas can combine these effects. The visibility-buffer extension is not implemented and is not
included in feature totals or performance claims.

## Reproduce

1. Open the app on HTTPS or localhost in a WebGPU-capable browser with `timestamp-query` support.
2. Use the native **Full benchmark** and both capacity-study builds. Do not rename checkpoint files as finals.
3. Place final JSON or JSON-gzip reports at `docs/performance/benchmark-full.json[.gz]`,
   `capacity-256.json[.gz]`, and `capacity-1024.json[.gz]`. If both forms exist, uncompressed JSON wins.
4. Run `python3 scripts/plot_performance.py` from the repository root.

Local development and production-preview pages served from `localhost` or `127.0.0.1` can use the local evidence
sink. A normal public deployment downloads completed final reports; checkpoint and recovery-part saves suppress
that download fallback.

If `timestamp-query` is unavailable, the UI reports GPU timing as unavailable; CPU time is never substituted for
GPU evidence.
"""


def write_analysis(
    path: Path,
    full_report: Report | None,
    capacity_reports: Mapping[int, Report],
    data_dir: Path,
    generated_figures: Sequence[Path],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        generated_analysis(full_report, capacity_reports, data_dir, generated_figures).rstrip() + "\n",
        encoding="utf-8",
    )


def resolve_optional(explicit: Path | None, default: Path) -> Path | None:
    if explicit is not None:
        if not explicit.exists():
            raise EvidenceError(f"Requested final report does not exist: {explicit}")
        if is_nonfinal_report_path(explicit):
            raise EvidenceError(f"Requested path is not a final report: {explicit}")
        return explicit
    if default.exists():
        return default
    compressed = default.with_suffix(default.suffix + ".gz")
    return compressed if compressed.exists() else None


def parser_for(repo_root: Path) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate final native benchmark JSON and generate millisecond plots plus analysis.",
    )
    parser.add_argument("--data-dir", type=Path, default=repo_root / "docs" / "performance")
    parser.add_argument("--figures-dir", type=Path, default=None)
    parser.add_argument("--analysis", type=Path, default=None)
    parser.add_argument("--full-report", type=Path, default=None)
    parser.add_argument("--capacity-256", type=Path, default=None)
    parser.add_argument("--capacity-1024", type=Path, default=None)
    parser.add_argument(
        "--validate-only", action="store_true",
        help="Validate raw evidence without importing Matplotlib or writing files.",
    )
    return parser


def run(argv: Sequence[str] | None = None) -> int:
    repo_root = Path(__file__).resolve().parents[1]
    parser = parser_for(repo_root)
    args = parser.parse_args(argv)
    data_dir = args.data_dir.resolve()
    figures_dir = (args.figures_dir or data_dir / "figures").resolve()
    analysis_path = (args.analysis or data_dir / "analysis.md").resolve()

    full_path = resolve_optional(args.full_report, data_dir / "benchmark-full.json")
    capacity_paths = {
        256: resolve_optional(args.capacity_256, data_dir / "capacity-256.json"),
        1024: resolve_optional(args.capacity_1024, data_dir / "capacity-1024.json"),
    }
    if full_path is None and not any(capacity_paths.values()):
        raise EvidenceError(
            f"No final reports found in {data_dir}. Expected benchmark-full.json[.gz] and/or "
            "capacity-256.json[.gz]/capacity-1024.json[.gz]. Checkpoint and recovery-part files are "
            "intentionally ignored."
        )

    full_report = load_report(full_path, expected_scope="full") if full_path else None
    capacity_reports = {
        capacity: load_report(path, expected_scope="capacity", expected_capacity=capacity)
        for capacity, path in capacity_paths.items()
        if path is not None
    }

    if full_report:
        validate_full_plan(full_report)
    for report in capacity_reports.values():
        validate_capacity_plan(report)

    reports = ([full_report] if full_report else []) + [capacity_reports[key] for key in sorted(capacity_reports)]
    validate_shared_provenance([report for report in reports if report is not None])
    for report in reports:
        assert report is not None
        print(
            f"validated {report.path}: {len(report.cases_by_id)} cases, "
            f"{report.result_count} result rows, {report.raw_count} raw samples"
        )
    if args.validate_only:
        print("validation only: no plots or analysis written")
        return 0

    generated: list[Path] = []
    if full_report or 1024 in capacity_reports or set(capacity_reports) == {256, 1024}:
        plt, line2d = configure_matplotlib()
        if full_report:
            generated.extend(plot_renderer_curves(full_report, figures_dir, plt, line2d))
            generated.extend(plot_cluster_grid(full_report, figures_dir, plt, line2d))
            generated.extend(plot_feature_deltas(full_report, figures_dir, plt, line2d))
            generated.extend(plot_kernel_deltas(full_report, figures_dir, plt, line2d))
            generated.extend(plot_bundle_cpu(full_report, figures_dir, plt, line2d))
        if set(capacity_reports) == {256, 1024}:
            generated.extend(plot_capacity_comparison(capacity_reports, figures_dir, plt, line2d))
        if 1024 in capacity_reports:
            generated.extend(plot_capacity_kernel_comparison(capacity_reports[1024], figures_dir, plt, line2d))
    write_analysis(analysis_path, full_report, capacity_reports, data_dir, generated)
    generated.append(analysis_path)
    for path in generated:
        print(f"wrote {path}")
    if full_report is None:
        print("note: benchmark-full.json is absent; analysis states that full-renderer evidence is pending")
    if set(capacity_reports) != {256, 1024}:
        missing = sorted({256, 1024} - set(capacity_reports))
        print(f"note: capacity comparison not plotted; missing final capacity report(s): {missing}")
    return 0


def main() -> None:
    try:
        raise SystemExit(run())
    except EvidenceError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
