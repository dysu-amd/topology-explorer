/* Shared BUILD_TOPOLOGY data-to-graph transformation. */
(() => {
  "use strict";

  const withDefaults = (fields, defaults) => ({ ...defaults, ...fields });

  function topologyToGraph(topology, sourceFile) {
    const nodes = [];
    const edges = [];
    const addNode = (nodeId, kind, name, fields) => {
      nodes.push({
        id: nodeId,
        kind,
        name,
        description: fields.description ?? "",
        fields,
      });
    };

    for (const [name, fields] of Object.entries(topology.source_sets ?? {})) {
      addNode(
        `source:${name}`,
        "source-set",
        name,
        withDefaults(fields, {
          description: "",
          submodules: [],
          external_git_sources: [],
          disable_platforms: [],
          path_prefixes: [],
        }),
      );
    }
    for (const [name, fields] of Object.entries(topology.artifact_groups ?? {})) {
      const groupFields = withDefaults(fields, {
        description: "",
        type: "generic",
        artifact_group_deps: [],
        source_sets: [],
      });
      addNode(`group:${name}`, "artifact-group", name, groupFields);
      for (const dependency of fields.artifact_group_deps ?? []) {
        edges.push({
          source: `group:${dependency}`,
          target: `group:${name}`,
          kind: "group-dependency",
        });
      }
    }
    for (const [name, fields] of Object.entries(topology.artifacts ?? {})) {
      const artifactFields = {
        ...withDefaults(fields, {
          description: "",
          type: "target-neutral",
          artifact_deps: [],
          platform: null,
          feature_name: null,
          feature_group: null,
          disable_platforms: [],
          disable_platforms_if_flags_not_set: {},
          disable_processors: [],
          python_requires: [],
          split_databases: [],
          test_artifacts: [],
          source_paths: [name],
        }),
        effective_feature_name:
          fields.feature_name ?? name.toUpperCase().replaceAll("-", "_"),
        effective_feature_group:
          fields.feature_group ??
          fields.artifact_group.toUpperCase().replaceAll("-", "_"),
      };
      if (artifactFields.source_paths.length === 0) {
        artifactFields.source_paths = [name];
      }
      addNode(`artifact:${name}`, "artifact", name, artifactFields);
      edges.push({
        source: `group:${fields.artifact_group}`,
        target: `artifact:${name}`,
        kind: "group-membership",
      });
      for (const dependency of fields.artifact_deps ?? []) {
        edges.push({
          source: `artifact:${dependency}`,
          target: `artifact:${name}`,
          kind: "artifact-dependency",
        });
      }
    }
    for (const [name, fields] of Object.entries(topology.build_stages ?? {})) {
      const stageFields = withDefaults(fields, {
        description: "",
        artifact_groups: [],
        type: "generic",
      });
      addNode(`stage:${name}`, "build-stage", name, stageFields);
      const stageSourceSets = new Set();
      for (const group of fields.artifact_groups ?? []) {
        for (const sourceSet of topology.artifact_groups?.[group]?.source_sets ?? []) {
          stageSourceSets.add(sourceSet);
        }
      }
      for (const sourceSet of stageSourceSets) {
        edges.push({
          source: `source:${sourceSet}`,
          target: `stage:${name}`,
          kind: "source-requirement",
        });
      }
      for (const group of fields.artifact_groups ?? []) {
        edges.push({
          source: `stage:${name}`,
          target: `group:${group}`,
          kind: "stage-membership",
        });
      }
    }

    return {
      metadata: { ...(topology.metadata ?? {}), source_file: sourceFile },
      nodes,
      edges,
    };
  }

  globalThis.topologyToGraph = topologyToGraph;
})();
