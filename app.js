(async () => {
  "use strict";

  const DEFAULT_TOPOLOGY_REF = "main";
  const topologySourceForm = document.querySelector("#topology-source-form");
  const topologyShaInput = document.querySelector("#topology-sha");
  const requestedTopologyRef = topologyRefFromLocation();
  topologyShaInput.value = requestedTopologyRef.sha ?? "";

  topologySourceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const sha = topologyShaInput.value.trim();
    if (sha && !isCommitSha(sha)) {
      topologyShaInput.setCustomValidity("Enter a 7–64 character hexadecimal commit SHA.");
      topologyShaInput.reportValidity();
      return;
    }
    topologyShaInput.setCustomValidity("");

    const url = new URL(window.location.href);
    if (sha) {
      url.searchParams.set("sha", sha);
    } else {
      url.searchParams.delete("sha");
    }
    window.location.assign(url);
  });

  const loadedTopology = requestedTopologyRef.error
    ? { data: null, error: requestedTopologyRef.error }
    : await loadTopologyData(
        topologyUrlForRef(requestedTopologyRef.ref),
        requestedTopologyRef.ref,
      );
  const data = loadedTopology.data;
  const svg = document.querySelector("#topology-graph");
  const viewport = document.querySelector("#viewport");
  const edgeLayer = document.querySelector("#edges");
  const nodeLayer = document.querySelector("#nodes");
  const detailsContent = document.querySelector("#details-content");
  const graphStatus = document.querySelector("#graph-status");
  const searchInput = document.querySelector("#search");
  const nodeFilters = document.querySelector("#node-filters");
  const edgeFilters = document.querySelector("#edge-filters");
  const fullSelectionGraphToggle = document.querySelector("#full-selection-graph");
  const cmakeFlagsInput = document.querySelector("#cmake-flags");
  const evaluateFlagsButton = document.querySelector("#evaluate-flags");
  const resetFlagsButton = document.querySelector("#reset-flags");
  const featureConfigResult = document.querySelector("#feature-config-result");
  const previewPlatformInputs = document.querySelectorAll('input[name="preview-platform"]');
  const previewPlatformDescription = document.querySelector("#preview-platform-description");

  if (!data) {
    detailsContent.innerHTML =
      `<div class="details-empty"><p><strong>Topology data is unavailable.</strong><br>${escapeHtml(loadedTopology.error)}</p></div>`;
    return;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const NODE_WIDTH = 196;
  const NODE_HEIGHT = 58;
  const VIEW_WIDTH = 1600;
  const VIEW_HEIGHT = 900;
  const NODE_KIND_LABELS = {
    "source-set": "Source set",
    "artifact-group": "Artifact group",
    artifact: "Artifact",
    "build-stage": "Build stage",
  };
  const EDGE_KIND_LABELS = {
    "source-requirement": "Source requirement",
    "group-dependency": "Group dependency",
    "group-membership": "Group membership",
    "artifact-dependency": "Artifact dependency",
    "stage-membership": "Build stage membership",
  };
  const ALL_NODE_KINDS = Object.keys(NODE_KIND_LABELS);
  const ALL_EDGE_KINDS = Object.keys(EDGE_KIND_LABELS);
  const FEATURE_GROUP_DEFAULTS = Object.freeze({
    ALL: true,
    CORE: "ALL",
    COMM_LIBS: "ALL",
    CV_LIBS: "ALL",
    STORAGE_LIBS: "ALL",
    DEBUG_TOOLS: "ALL",
    MATH_LIBS: "ALL",
    ML_LIBS: "ALL",
    PROFILER: "ALL",
    DC_TOOLS: "ALL",
    MEDIA_LIBS: "ALL",
    EMULATION: "ALL",
    HOST_MATH: false,
    WSL: false,
  });

  function isCommitSha(value) {
    return /^[0-9a-f]{7,64}$/i.test(value);
  }

  function topologyRefFromLocation() {
    const sha = new URLSearchParams(window.location.search).get("sha")?.trim();
    if (!sha) {
      return { ref: DEFAULT_TOPOLOGY_REF, sha: "" };
    }
    if (!isCommitSha(sha)) {
      return {
        ref: DEFAULT_TOPOLOGY_REF,
        sha,
        error: "The requested topology SHA must be 7–64 hexadecimal characters.",
      };
    }
    return { ref: sha, sha };
  }

  function topologyUrlForRef(ref) {
    return `https://raw.githubusercontent.com/ROCm/TheRock/${ref}/BUILD_TOPOLOGY.toml`;
  }

  async function loadTopologyData(url, ref) {
    try {
      if (typeof window.parseTopologyToml !== "function") {
        throw new Error("The local TOML parser did not load");
      }
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`TheRock returned HTTP ${response.status}`);
      }
      const topology = window.parseTopologyToml(await response.text());
      return {
        data: topologyToGraph(topology, `ROCm/TheRock ${ref}`),
      };
    } catch (error) {
      console.warn("Could not load the live BUILD_TOPOLOGY.toml:", error);
      return {
        data: null,
        error: `Could not load BUILD_TOPOLOGY.toml from TheRock ${ref}: ${error.message}`,
      };
    }
  }

  const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  const artifactNodes = data.nodes.filter((node) => node.kind === "artifact");
  const positions = new Map();
  const renderedNodeElements = new Map();
  const renderedEdgeElements = [];

  const state = {
    selectedId: null,
    query: "",
    showFullSelectionGraph: true,
    buildSelection: null,
    previewPlatform: "linux",
    visibleNodeKinds: new Set(ALL_NODE_KINDS),
    visibleEdgeKinds: new Set(ALL_EDGE_KINDS),
    panX: 0,
    panY: 0,
    scale: 1,
    scene: { width: VIEW_WIDTH, height: VIEW_HEIGHT },
  };

  function createSvgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [attribute, value] of Object.entries(attributes)) {
      element.setAttribute(attribute, value);
    }
    return element;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function parseBoolean(value) {
    const normalized = value.trim().replaceAll(/^['"]|['"]$/g, "").toUpperCase();
    if (["1", "ON", "TRUE", "YES", "Y"].includes(normalized)) {
      return true;
    }
    if (["0", "OFF", "FALSE", "NO", "N", "IGNORE", "NOTFOUND", ""].includes(normalized)) {
      return false;
    }
    return null;
  }

  function parseFeatureFlags(input) {
    const flags = new Map();
    const warnings = [];
    const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (const token of tokens) {
      if (!token.startsWith("-DTHEROCK_ENABLE_")) {
        continue;
      }
      const assignment = token.slice(2);
      const equalsIndex = assignment.indexOf("=");
      if (equalsIndex < 0) {
        warnings.push(`Ignored ${token}: CMake feature flags need =ON or =OFF.`);
        continue;
      }
      const name = assignment.slice(0, equalsIndex).split(":", 1)[0];
      const value = parseBoolean(assignment.slice(equalsIndex + 1));
      if (value === null) {
        warnings.push(`Ignored ${token}: expected a CMake boolean value.`);
        continue;
      }
      flags.set(name, value);
    }
    return { flags, warnings };
  }

  function featureNameForArtifact(artifact) {
    return artifact.fields.effective_feature_name;
  }

  function featureGroupForArtifact(artifact) {
    return artifact.fields.effective_feature_group;
  }

  function isModeledFeatureFlag(name) {
    return (
      artifactNodes.some(
        (artifact) => name === `THEROCK_ENABLE_${featureNameForArtifact(artifact)}`,
      ) ||
      Object.hasOwn(FEATURE_GROUP_DEFAULTS, name.replace("THEROCK_ENABLE_", ""))
    );
  }

  function ineffectiveFlagWarning(name, value, selection, comparison) {
    const artifact = artifactNodes.find(
      (candidate) => name === `THEROCK_ENABLE_${featureNameForArtifact(candidate)}`,
    );
    const result = artifact ? selection.artifacts.get(artifact.name) : null;
    const comparisonResult = artifact
      ? comparison.artifacts.get(artifact.name)
      : null;
    if (result?.status === "unavailable") {
      return `${name}=${value ? "ON" : "OFF"} has no effect on the final artifact selection because ${artifact.name} is not supported on ${platformDisplayName()}.`;
    }
    if (
      value &&
      state.previewPlatform === "linux" &&
      comparisonResult?.enabled
    ) {
      return `${name}=ON has no effect on the final artifact selection because ${artifact.name} is already enabled elsewhere.`;
    }
    if (!value && result?.enabled && result.requiredBy.size > 0) {
      const requiredBy = [...result.requiredBy].sort().join(", ");
      return `${name}=OFF has no effect: ${artifact.name} remains enabled because ${requiredBy} requires it.`;
    }
    return `${name}=${value ? "ON" : "OFF"} has no effect on the final artifact selection.`;
  }

  function evaluateBuildSelection(input) {
    const { flags, warnings } = parseFeatureFlags(input);
    for (const name of flags.keys()) {
      if (!isModeledFeatureFlag(name)) {
        warnings.push(`${name} does not select a topology artifact in this preview.`);
      }
    }
    const selection = resolveBuildSelection(flags, warnings);
    for (const [name, value] of flags) {
      if (!isModeledFeatureFlag(name)) {
        continue;
      }
      const comparisonFlags = new Map(flags);
      comparisonFlags.delete(name);
      const comparison = resolveBuildSelection(comparisonFlags, []);
      const hasEffect = [...selection.artifacts].some(
        ([artifactName, result]) => result.enabled !== comparison.artifacts.get(artifactName).enabled,
      );
      if (!hasEffect) {
        warnings.push(
          ineffectiveFlagWarning(name, value, selection, comparison),
        );
      }
    }
    return selection;
  }

  function resolveBuildSelection(flags, warnings) {

    const groupValues = new Map();
    const getGroupValue = (group) => {
      if (groupValues.has(group)) {
        return groupValues.get(group);
      }
      const optionName = `THEROCK_ENABLE_${group}`;
      let value;
      if (flags.has(optionName)) {
        value = flags.get(optionName);
      } else if (FEATURE_GROUP_DEFAULTS[group] === "ALL") {
        value = getGroupValue("ALL");
      } else if (Object.hasOwn(FEATURE_GROUP_DEFAULTS, group)) {
        value = FEATURE_GROUP_DEFAULTS[group];
      } else {
        value = false;
        warnings.push(`No default rule is modeled for feature group ${group}.`);
      }
      groupValues.set(group, value);
      return value;
    };

    const artifacts = new Map();
    for (const artifact of artifactNodes) {
      const featureName = featureNameForArtifact(artifact);
      const featureGroup = featureGroupForArtifact(artifact);
      const optionName = `THEROCK_ENABLE_${featureName}`;
      const isExplicit = flags.has(optionName);
      const isPlatformUnavailable =
        (artifact.fields.platform && artifact.fields.platform !== state.previewPlatform) ||
        (artifact.fields.disable_platforms ?? []).includes(state.previewPlatform);
      const isEnabled = isPlatformUnavailable
        ? false
        : isExplicit
          ? flags.get(optionName)
          : getGroupValue(featureGroup);
      artifacts.set(artifact.name, {
        artifact,
        enabled: isEnabled,
        status: isPlatformUnavailable
          ? "unavailable"
          : isEnabled
            ? "enabled"
            : "disabled",
        reason: isPlatformUnavailable
          ? `Unavailable on ${platformDisplayName()}`
          : isExplicit
          ? `${optionName}=${isEnabled ? "ON" : "OFF"}`
          : `THEROCK_ENABLE_${featureGroup}=${isEnabled ? "ON" : "OFF"}`,
        requiredBy: new Set(),
      });
    }

    const pending = [...artifacts.values()]
      .filter((result) => result.enabled)
      .map((result) => result.artifact.name);
    const expanded = new Set();
    while (pending.length > 0) {
      const artifactName = pending.shift();
      if (expanded.has(artifactName)) {
        continue;
      }
      expanded.add(artifactName);
      const result = artifacts.get(artifactName);
      for (const dependencyName of result.artifact.fields.artifact_deps ?? []) {
        const dependency = artifacts.get(dependencyName);
        if (!dependency) {
          warnings.push(`${artifactName} references unknown artifact ${dependencyName}.`);
          continue;
        }
        if (dependency.status === "unavailable") {
          continue;
        }
        dependency.requiredBy.add(artifactName);
        if (!dependency.enabled) {
          dependency.enabled = true;
          dependency.status = "implicit";
          dependency.reason = `Required by ${artifactName}`;
        }
        pending.push(dependencyName);
      }
    }

    const enabled = [...artifacts.values()].filter((result) => result.enabled);
    const implicit = enabled.filter((result) => result.status === "implicit");
    return {
      artifacts,
      warnings,
      enabledCount: enabled.length,
      disabledCount: artifacts.size - enabled.length,
      implicitCount: implicit.length,
    };
  }

  function artifactNamesForNode(node) {
    if (node.kind === "artifact") {
      return [node.name];
    }
    let groups = [];
    if (node.kind === "artifact-group") {
      groups = [node.name];
    } else if (node.kind === "build-stage") {
      groups = node.fields.artifact_groups ?? [];
    } else if (node.kind === "source-set") {
      const stages = data.edges
        .filter(
          (edge) => edge.kind === "source-requirement" && edge.source === node.id,
        )
        .map((edge) => nodeById.get(edge.target));
      groups = stages.flatMap((stage) => stage?.fields.artifact_groups ?? []);
    }
    return artifactNodes
      .filter((artifact) => groups.includes(artifact.fields.artifact_group))
      .map((artifact) => artifact.name);
  }

  function buildStateForNode(node) {
    const selection = state.buildSelection;
    if (!selection) {
      return null;
    }
    const artifactNames = artifactNamesForNode(node);
    const results = artifactNames
      .map((artifactName) => selection.artifacts.get(artifactName))
      .filter(Boolean);
    const enabledCount = results.filter((result) => result.enabled).length;
    const implicitCount = results.filter((result) => result.status === "implicit").length;
    const unavailableCount = results.filter((result) => result.status === "unavailable").length;
    let status = "disabled";
    if (results.length === 0) {
      status = "disabled";
    } else if (enabledCount === 0) {
      status = unavailableCount === results.length ? "unavailable" : "disabled";
    } else if (enabledCount < results.length) {
      status = "partial";
    } else if (implicitCount > 0) {
      status = "implicit";
    } else {
      status = "enabled";
    }
    return {
      status,
      enabledCount,
      totalCount: results.length,
      result: node.kind === "artifact" ? results[0] : null,
    };
  }

  function renderFeatureConfigResult() {
    const selection = state.buildSelection;
    const warningCount = selection.warnings.length;
    featureConfigResult.textContent = `${selection.enabledCount} built · ${selection.disabledCount} not built · ${selection.implicitCount} implicit${warningCount ? ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`;
    featureConfigResult.title = selection.warnings.join("\n");
    featureConfigResult.classList.toggle("has-warnings", selection.warnings.length > 0);
  }

  function layoutGraph() {
    const adjacency = new Map(data.nodes.map((node) => [node.id, []]));
    const indegree = new Map(data.nodes.map((node) => [node.id, 0]));
    const level = new Map(data.nodes.map((node) => [node.id, 0]));

    for (const edge of data.edges) {
      adjacency.get(edge.source)?.push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }

    const queue = data.nodes
      .filter((node) => indegree.get(node.id) === 0)
      .map((node) => node.id);
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const sourceId = queue[queueIndex++];
      for (const targetId of adjacency.get(sourceId) ?? []) {
        level.set(targetId, Math.max(level.get(targetId), level.get(sourceId) + 1));
        const nextIndegree = indegree.get(targetId) - 1;
        indegree.set(targetId, nextIndegree);
        if (nextIndegree === 0) {
          queue.push(targetId);
        }
      }
    }

    // The topology is validated as a DAG. Keep a usable layout if malformed data
    // is ever loaded into the static explorer.
    for (const node of data.nodes) {
      if (indegree.get(node.id) > 0) {
        level.set(node.id, Math.max(level.get(node.id), 1));
      }
    }

    const nodesByLevel = new Map();
    for (const node of data.nodes) {
      const nodeLevel = level.get(node.id);
      const nodes = nodesByLevel.get(nodeLevel) ?? [];
      nodes.push(node);
      nodesByLevel.set(nodeLevel, nodes);
    }

    const kindOrder = new Map([
      ["source-set", 0],
      ["build-stage", 1],
      ["artifact-group", 2],
      ["artifact", 3],
    ]);
    let longestColumn = 0;
    for (const nodes of nodesByLevel.values()) {
      nodes.sort(
        (left, right) =>
          kindOrder.get(left.kind) - kindOrder.get(right.kind) ||
          left.name.localeCompare(right.name),
      );
      longestColumn = Math.max(longestColumn, nodes.length);
    }

    const levels = [...nodesByLevel.keys()];
    const maxLevel = Math.max(...levels, 0);
    const columnGap = 272;
    const rowGap = 78;
    for (const [nodeLevel, nodes] of nodesByLevel) {
      nodes.forEach((node, index) => {
        positions.set(node.id, {
          x: 52 + nodeLevel * columnGap,
          y: 58 + index * rowGap,
        });
      });
    }

    state.scene = {
      width: Math.max(VIEW_WIDTH, 52 + maxLevel * columnGap + NODE_WIDTH + 70),
      height: Math.max(VIEW_HEIGHT, 58 + longestColumn * rowGap + 60),
    };
  }

  function labelLines(name) {
    const pieces = name.split("-");
    const lines = [];
    let line = "";
    for (const piece of pieces) {
      const candidate = line ? `${line}-${piece}` : piece;
      if (candidate.length > 23 && line) {
        lines.push(line);
        line = piece;
      } else {
        line = candidate;
      }
    }
    if (line) {
      lines.push(line);
    }
    if (lines.length <= 2) {
      return lines;
    }
    return [lines[0], `${lines.slice(1).join("-").slice(0, 20)}…`];
  }

  function edgePath(sourcePosition, targetPosition) {
    const startX = sourcePosition.x + NODE_WIDTH;
    const startY = sourcePosition.y + NODE_HEIGHT / 2;
    const endX = targetPosition.x;
    const endY = targetPosition.y + NODE_HEIGHT / 2;
    const bend = Math.max(46, (endX - startX) * 0.46);
    return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
  }

  function renderGraph() {
    layoutGraph();
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    renderedNodeElements.clear();
    renderedEdgeElements.length = 0;

    for (const edge of data.edges) {
      const sourcePosition = positions.get(edge.source);
      const targetPosition = positions.get(edge.target);
      if (!sourcePosition || !targetPosition) {
        continue;
      }
      const path = createSvgElement("path", {
        d: edgePath(sourcePosition, targetPosition),
        class: `graph-edge ${edge.kind}`,
        "data-edge-kind": edge.kind,
        "data-source": edge.source,
        "data-target": edge.target,
      });
      edgeLayer.append(path);
      renderedEdgeElements.push({ edge, element: path });
    }

    for (const node of data.nodes) {
      const position = positions.get(node.id);
      const group = createSvgElement("g", {
        class: `graph-node ${node.kind}`,
        transform: `translate(${position.x} ${position.y})`,
        tabindex: "0",
        role: "button",
        "aria-label": `${NODE_KIND_LABELS[node.kind]}: ${node.name}`,
        "data-node-id": node.id,
      });
      const title = createSvgElement("title");
      title.textContent = `${NODE_KIND_LABELS[node.kind]}: ${node.name}`;
      group.append(title);
      group.append(
        createSvgElement("rect", {
          class: "node-card",
          x: "0",
          y: "0",
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          rx: node.kind === "build-stage" ? "18" : "7",
        }),
      );
      const kindLabel = createSvgElement("text", {
        class: "node-kind",
        x: "12",
        y: "18",
      });
      kindLabel.textContent = NODE_KIND_LABELS[node.kind];
      group.append(kindLabel);

      labelLines(node.name).forEach((line, index) => {
        const nameLabel = createSvgElement("text", {
          class: "node-name",
          x: "12",
          y: String(37 + index * 13),
        });
        nameLabel.textContent = line;
        group.append(nameLabel);
      });

      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectNode(node.id);
      });
      group.addEventListener("mousedown", (event) => event.preventDefault());
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectNode(node.id);
        }
      });
      nodeLayer.append(group);
      renderedNodeElements.set(node.id, group);
    }

    updateGraphPresentation();
  }

  function nodeMatchesQuery(node) {
    if (!state.query) {
      return true;
    }
    const haystack = `${node.name} ${node.description} ${node.kind}`.toLowerCase();
    return haystack.includes(state.query);
  }

  function isNodeVisible(node) {
    const isDirectlyUnavailable =
      (node.fields.platform && node.fields.platform !== state.previewPlatform) ||
      (node.fields.disable_platforms ?? []).includes(state.previewPlatform);
    return (
      state.visibleNodeKinds.has(node.kind) &&
      !isDirectlyUnavailable &&
      buildStateForNode(node)?.status !== "unavailable"
    );
  }

  function isEdgeVisible(edge) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    return (
      state.visibleEdgeKinds.has(edge.kind) &&
      isNodeVisible(source) &&
      isNodeVisible(target)
    );
  }

  function collectSelectionGraph(selectedId) {
    const relatedNodeIds = new Set();
    const relatedEdges = new Set();
    if (!selectedId) {
      return { relatedNodeIds, relatedEdges };
    }
    relatedNodeIds.add(selectedId);

    for (const direction of ["upstream", "downstream"]) {
      const visited = new Set([selectedId]);
      const pending = [selectedId];
      while (pending.length > 0) {
        const currentId = pending.shift();
        for (const { edge, element } of renderedEdgeElements) {
          const isRelated =
            direction === "upstream"
              ? edge.target === currentId
              : edge.source === currentId;
          if (!isRelated) {
            continue;
          }
          const adjacentId =
            direction === "upstream" ? edge.source : edge.target;
          relatedNodeIds.add(adjacentId);
          relatedEdges.add(element);
          if (state.showFullSelectionGraph && !visited.has(adjacentId)) {
            visited.add(adjacentId);
            pending.push(adjacentId);
          }
        }
      }
    }
    return { relatedNodeIds, relatedEdges };
  }

  function updateGraphPresentation() {
    const { relatedNodeIds, relatedEdges } = collectSelectionGraph(state.selectedId);

    for (const [nodeId, element] of renderedNodeElements) {
      const node = nodeById.get(nodeId);
      const hidden = !isNodeVisible(node);
      element.classList.toggle("is-hidden", hidden);
      element.classList.toggle("is-selected", nodeId === state.selectedId);
      element.classList.toggle(
        "is-search-muted",
        !hidden && !nodeMatchesQuery(node),
      );
      element.classList.toggle(
        "is-muted",
        Boolean(state.selectedId) && !relatedNodeIds.has(nodeId),
      );
      const buildState = buildStateForNode(node);
      for (const status of ["enabled", "implicit", "partial", "disabled", "unavailable"]) {
        element.classList.toggle(`build-${status}`, buildState?.status === status);
      }
    }

    for (const { edge, element } of renderedEdgeElements) {
      const visible = isEdgeVisible(edge);
      const sourceMatches = nodeMatchesQuery(nodeById.get(edge.source));
      const targetMatches = nodeMatchesQuery(nodeById.get(edge.target));
      element.classList.toggle("is-hidden", !visible);
      element.classList.toggle(
        "is-related",
        relatedEdges.has(element) && visible,
      );
      element.classList.toggle(
        "is-muted",
        visible &&
          ((state.selectedId && !relatedEdges.has(element)) ||
            (state.query && !sourceMatches && !targetMatches)),
      );
    }

    const visibleCount = data.nodes.filter(isNodeVisible).length;
    const selectedNode = nodeById.get(state.selectedId);
    graphStatus.textContent = selectedNode
      ? `Selected: ${selectedNode.name} · ${Math.round(state.scale * 100)}%`
      : `${visibleCount} visible nodes · ${Math.round(state.scale * 100)}%`;
  }

  function formattedKind(kind) {
    return NODE_KIND_LABELS[kind] ?? kind;
  }

  function formatValue(value) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return '<span class="detail-pill">None</span>';
      }
      return `<div class="detail-pills">${value
        .map((item) => {
          if (typeof item === "object" && item !== null) {
            const parts = [item.name, item.path, item.commit]
              .filter(Boolean)
              .map(String);
            return `<span class="detail-pill">${escapeHtml(parts.join(" · "))}</span>`;
          }
          return `<span class="detail-pill">${escapeHtml(item)}</span>`;
        })
        .join("")}</div>`;
    }
    if (typeof value === "object" && value !== null) {
      return `<div class="detail-pills">${Object.entries(value)
        .map(
          ([key, item]) =>
            `<span class="detail-pill">${escapeHtml(key)}: ${escapeHtml(item)}</span>`,
        )
        .join("")}</div>`;
    }
    return `<span>${escapeHtml(value)}</span>`;
  }

  function fieldsForNode(node) {
    const sourceFields = node.fields;
    const fieldOrder = {
      "source-set": [
        "submodules",
        "external_git_sources",
        "disable_platforms",
        "path_prefixes",
      ],
      "artifact-group": ["type", "artifact_group_deps", "source_sets"],
      artifact: [
        "artifact_group",
        "type",
        "effective_feature_name",
        "effective_feature_group",
        "platform",
        "disable_platforms",
        "disable_platforms_if_flags_not_set",
        "disable_processors",
        "python_requires",
        "split_databases",
        "test_artifacts",
      ],
      "build-stage": ["type", "artifact_groups"],
    };
    return (fieldOrder[node.kind] ?? [])
      .filter((field) => sourceFields[field] !== undefined)
      .map((field) => ({
        label: field.replaceAll("_", " "),
        value: sourceFields[field],
      }));
  }

  function relationshipLabel(edge, selectedId) {
    const isSource = edge.source === selectedId;
    const labels = {
      "source-requirement": isSource ? "Required by stage" : "Uses source set",
      "group-dependency": isSource ? "Prerequisite of group" : "Depends on group",
      "group-membership": isSource ? "Contains artifact" : "Belongs to group",
      "artifact-dependency": isSource ? "Required by artifact" : "Depends on artifact",
      "stage-membership": isSource ? "Builds group" : "Built in stage",
    };
    return labels[edge.kind];
  }

  function relationshipsForNode(nodeId) {
    return data.edges
      .filter((edge) => edge.source === nodeId || edge.target === nodeId)
      .map((edge) => {
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        return {
          edge,
          node: nodeById.get(otherId),
          label: relationshipLabel(edge, nodeId),
        };
      })
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.node.name.localeCompare(right.node.name),
      );
  }

  function selectionLabel(result) {
    if (result.status === "unavailable") {
      return "Unavailable";
    }
    if (!result.enabled) {
      return "Not built";
    }
    return result.status === "implicit" ? "Implicitly enabled" : "Enabled";
  }

  function attachNodeLinkListeners() {
    detailsContent.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => selectNode(button.dataset.nodeId));
    });
  }

  function componentResultList(results) {
    return results
      .sort((left, right) => left.artifact.name.localeCompare(right.artifact.name))
      .map(
        (result) => `
          <li>
            <button class="relationship-link component-result ${result.enabled ? "is-built" : "is-not-built"}" type="button" data-node-id="artifact:${escapeHtml(result.artifact.name)}">
              <span class="relationship-label">${escapeHtml(selectionLabel(result))}</span>
              <span class="relationship-name">${escapeHtml(result.artifact.name)}</span>
            </button>
          </li>`,
      )
      .join("");
  }

  function previewWarningsMarkup() {
    const warnings = state.buildSelection.warnings;
    if (warnings.length === 0) {
      return "";
    }
    return `
      <section class="detail-section preview-warnings">
        <h3>Flag warnings (${warnings.length})</h3>
        <ul class="preview-notes">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>
      </section>`;
  }

  function renderBuildSelectionOverview() {
    const results = [...state.buildSelection.artifacts.values()];
    const built = results.filter((result) => result.enabled);
    const notBuilt = results.filter((result) => !result.enabled);
    detailsContent.innerHTML = `
      <span class="detail-kind build-selection">Feature preview</span>
      <h3 class="detail-title">Build selection</h3>
      <p class="detail-description">Fresh ${escapeHtml(platformDisplayName())} x86_64 configuration evaluated from <code>THEROCK_ENABLE_*</code> flags.</p>
      ${previewWarningsMarkup()}
      <section class="detail-section">
        <h3>Components to build (${built.length})</h3>
        <ul class="relationship-list component-result-list">${componentResultList(built)}</ul>
      </section>
      <section class="detail-section">
        <h3>Components not built (${notBuilt.length})</h3>
        <ul class="relationship-list component-result-list">${componentResultList(notBuilt)}</ul>
      </section>`;
    attachNodeLinkListeners();
  }

  function renderDetails(nodeId) {
    const node = nodeById.get(nodeId);
    if (!node) {
      renderBuildSelectionOverview();
      return;
    }

    const properties = fieldsForNode(node)
      .map(
        ({ label, value }) =>
          `<dt>${escapeHtml(label)}</dt><dd>${formatValue(value)}</dd>`,
      )
      .join("");
    const relationships = relationshipsForNode(node.id)
      .map(
        ({ node: relatedNode, label }) => `
          <li>
            <button class="relationship-link" type="button" data-node-id="${escapeHtml(relatedNode.id)}">
              <span class="relationship-label">${escapeHtml(label)} · ${escapeHtml(formattedKind(relatedNode.kind))}</span>
              <span class="relationship-name">${escapeHtml(relatedNode.name)}</span>
            </button>
          </li>`,
      )
      .join("");
    const buildState = buildStateForNode(node);
    const buildSelection = buildState.result
      ? `${selectionLabel(buildState.result)} · ${escapeHtml(buildState.result.reason)}`
      : `${buildState.enabledCount} of ${buildState.totalCount} artifacts enabled`;

    detailsContent.innerHTML = `
      <span class="detail-kind ${escapeHtml(node.kind)}">${escapeHtml(formattedKind(node.kind))}</span>
      <h3 class="detail-title">${escapeHtml(node.name)}</h3>
      ${node.description ? `<p class="detail-description">${escapeHtml(node.description)}</p>` : ""}
      ${previewWarningsMarkup()}
      <section class="detail-section build-selection-status build-${escapeHtml(buildState.status)}">
        <h3>Feature selection</h3>
        <p>${buildSelection}</p>
      </section>
      <section class="detail-section">
        <h3>Declared properties</h3>
        ${properties ? `<dl class="property-list">${properties}</dl>` : '<p class="detail-description">No additional properties.</p>'}
      </section>
      <section class="detail-section">
        <h3>Direct relationships (${relationshipsForNode(node.id).length})</h3>
        ${relationships ? `<ul class="relationship-list">${relationships}</ul>` : '<p class="detail-description">No direct relationships.</p>'}
      </section>`;

    attachNodeLinkListeners();
  }

  function selectNode(nodeId) {
    if (state.selectedId === nodeId) {
      state.selectedId = null;
      renderDetails(null);
      updateGraphPresentation();
      return;
    }
    state.selectedId = nodeId;
    renderDetails(nodeId);
    updateGraphPresentation();
  }

  function applyTransform() {
    viewport.setAttribute(
      "transform",
      `translate(${state.panX} ${state.panY}) scale(${state.scale})`,
    );
    updateGraphPresentation();
  }

  function visibleSceneBounds() {
    const visiblePositions = data.nodes
      .filter(isNodeVisible)
      .map((node) => positions.get(node.id));
    if (visiblePositions.length === 0) {
      return { minX: 0, minY: 0, maxX: VIEW_WIDTH, maxY: VIEW_HEIGHT };
    }
    return {
      minX: Math.min(...visiblePositions.map((position) => position.x)),
      minY: Math.min(...visiblePositions.map((position) => position.y)),
      maxX: Math.max(...visiblePositions.map((position) => position.x + NODE_WIDTH)),
      maxY: Math.max(...visiblePositions.map((position) => position.y + NODE_HEIGHT)),
    };
  }

  function fitGraph() {
    const bounds = visibleSceneBounds();
    const padding = 54;
    const width = bounds.maxX - bounds.minX + padding * 2;
    const height = bounds.maxY - bounds.minY + padding * 2;
    state.scale = Math.min(
      1.25,
      Math.max(0.13, Math.min(VIEW_WIDTH / width, VIEW_HEIGHT / height)),
    );
    state.panX = (VIEW_WIDTH - width * state.scale) / 2 - (bounds.minX - padding) * state.scale;
    state.panY = (VIEW_HEIGHT - height * state.scale) / 2 - (bounds.minY - padding) * state.scale;
    applyTransform();
  }

  function syncCheckboxes(container, values) {
    container.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
      checkbox.checked = values.has(checkbox.value);
    });
  }

  function resetExplorer() {
    state.selectedId = null;
    state.query = "";
    state.showFullSelectionGraph = true;
    state.visibleNodeKinds = new Set(ALL_NODE_KINDS);
    state.visibleEdgeKinds = new Set(ALL_EDGE_KINDS);
    searchInput.value = "";
    syncCheckboxes(nodeFilters, state.visibleNodeKinds);
    syncCheckboxes(edgeFilters, state.visibleEdgeKinds);
    fullSelectionGraphToggle.checked = true;
    renderDetails(null);
    fitGraph();
  }

  function applyFeatureFlags() {
    state.buildSelection = evaluateBuildSelection(cmakeFlagsInput.value);
    renderFeatureConfigResult();
    renderDetails(state.selectedId);
    updateGraphPresentation();
  }

  function platformDisplayName() {
    return state.previewPlatform === "windows" ? "Windows" : "Linux";
  }

  function setPreviewPlatform(platform) {
    state.previewPlatform = platform;
    previewPlatformDescription.textContent = platformDisplayName();
    applyFeatureFlags();
    if (state.selectedId && !isNodeVisible(nodeById.get(state.selectedId))) {
      state.selectedId = null;
      renderDetails(null);
      updateGraphPresentation();
    }
    fitGraph();
  }

  function graphPoint(event) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  }

  function installPanAndZoom() {
    let panStart = null;

    svg.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest?.(".graph-node")) {
        return;
      }
      event.preventDefault();
      const point = graphPoint(event);
      panStart = {
        pointerId: event.pointerId,
        x: point.x,
        y: point.y,
        panX: state.panX,
        panY: state.panY,
      };
      svg.setPointerCapture(event.pointerId);
      svg.classList.add("is-panning");
    });

    svg.addEventListener("pointermove", (event) => {
      if (!panStart || event.pointerId !== panStart.pointerId) {
        return;
      }
      const point = graphPoint(event);
      state.panX = panStart.panX + point.x - panStart.x;
      state.panY = panStart.panY + point.y - panStart.y;
      applyTransform();
    });

    const stopPanning = (event) => {
      if (!panStart || event.pointerId !== panStart.pointerId) {
        return;
      }
      if (svg.hasPointerCapture(event.pointerId)) {
        svg.releasePointerCapture(event.pointerId);
      }
      panStart = null;
      svg.classList.remove("is-panning");
    };
    svg.addEventListener("pointerup", stopPanning);
    svg.addEventListener("pointercancel", stopPanning);

    svg.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const point = graphPoint(event);
        const oldScale = state.scale;
        const scaleFactor = event.deltaY < 0 ? 1.13 : 0.885;
        const newScale = Math.min(3.5, Math.max(0.1, oldScale * scaleFactor));
        state.panX = point.x - ((point.x - state.panX) * newScale) / oldScale;
        state.panY = point.y - ((point.y - state.panY) * newScale) / oldScale;
        state.scale = newScale;
        applyTransform();
      },
      { passive: false },
    );
  }

  nodeFilters.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (checkbox.checked) {
      state.visibleNodeKinds.add(checkbox.value);
    } else {
      state.visibleNodeKinds.delete(checkbox.value);
    }
    updateGraphPresentation();
    fitGraph();
  });

  edgeFilters.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (checkbox.checked) {
      state.visibleEdgeKinds.add(checkbox.value);
    } else {
      state.visibleEdgeKinds.delete(checkbox.value);
    }
    updateGraphPresentation();
  });

  fullSelectionGraphToggle.addEventListener("change", () => {
    state.showFullSelectionGraph = fullSelectionGraphToggle.checked;
    updateGraphPresentation();
  });

  searchInput.addEventListener("input", () => {
    state.query = searchInput.value.trim().toLowerCase();
    updateGraphPresentation();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    const matchingNode = data.nodes.find(
      (node) => isNodeVisible(node) && nodeMatchesQuery(node),
    );
    if (matchingNode) {
      selectNode(matchingNode.id);
    }
  });

  document.querySelector("#fit-graph").addEventListener("click", fitGraph);
  document.querySelector("#reset-filters").addEventListener("click", resetExplorer);
  evaluateFlagsButton.addEventListener("click", applyFeatureFlags);
  resetFlagsButton.addEventListener("click", () => {
    cmakeFlagsInput.value = "";
    applyFeatureFlags();
  });
  previewPlatformInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        setPreviewPlatform(input.value);
      }
    });
  });
  cmakeFlagsInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      applyFeatureFlags();
    }
  });

  state.buildSelection = evaluateBuildSelection(cmakeFlagsInput.value);
  renderGraph();
  renderFeatureConfigResult();
  renderDetails(null);
  installPanAndZoom();
  fitGraph();
})();
