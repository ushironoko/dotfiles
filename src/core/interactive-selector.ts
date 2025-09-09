import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
} from "@clack/prompts";
import type { FileMapping } from "../types/config.js";
import type { Logger } from "../utils/logger.js";

interface MappingOption {
  value: string;
  label: string;
  hint?: string;
  parentMapping?: FileMapping;
  fileName?: string;
}

const formatMapping = (mapping: FileMapping): MappingOption => {
  const typeLabel = mapping.type === "selective" ? "selective" : mapping.type;
  const hint =
    mapping.type === "selective" && mapping.include
      ? `${mapping.include.length} files`
      : undefined;

  return {
    value: `${mapping.source}:${mapping.target}`,
    label: `${mapping.target} (${typeLabel})`,
    hint,
  };
};

const groupMappingsByType = (mappings: FileMapping[]) => {
  const grouped: { [key: string]: FileMapping[] } = {
    file: [],
    directory: [],
    selective: [],
  };

  for (const mapping of mappings) {
    grouped[mapping.type].push(mapping);
  }

  return grouped;
};

const buildFileOptions = (mappings: FileMapping[]): MappingOption[] => {
  return mappings.map((mapping, index) => {
    const option = formatMapping(mapping);
    if (index === 0) {
      return { ...option, label: `[Files] ${option.label}` };
    }
    return option;
  });
};

const buildDirectoryOptions = (mappings: FileMapping[]): MappingOption[] => {
  return mappings.map((mapping, index) => {
    const option = formatMapping(mapping);
    if (index === 0) {
      return { ...option, label: `[Directories] ${option.label}` };
    }
    return option;
  });
};

const buildSelectiveOptions = (mappings: FileMapping[]): MappingOption[] => {
  const result: MappingOption[] = [];

  mappings.forEach((mapping, index) => {
    const headerLabel =
      index === 0 ? `[Selective] ${mapping.target}` : `${mapping.target}`;

    if (mapping.include && mapping.include.length > 0) {
      mapping.include.forEach((file, fileIndex) => {
        const label =
          fileIndex === 0 ? `${headerLabel}\n  └─ ${file}` : `  └─ ${file}`;

        result.push({
          value: `${mapping.source}:${mapping.target}:${file}`,
          label,
          parentMapping: mapping,
          fileName: file,
        });
      });
    }
  });

  return result;
};

const buildOptionsWithLabels = (grouped: {
  [key: string]: FileMapping[];
}): MappingOption[] => {
  const result: MappingOption[] = [];

  if (grouped.file.length > 0) {
    result.push(...buildFileOptions(grouped.file));
  }

  if (grouped.directory.length > 0) {
    result.push(...buildDirectoryOptions(grouped.directory));
  }

  if (grouped.selective.length > 0) {
    result.push(...buildSelectiveOptions(grouped.selective));
  }

  return result;
};

interface SelectionResult {
  selected: FileMapping[];
  deselected: FileMapping[];
}

const detectExistingSymlinks = async (
  optionsWithLabels: MappingOption[],
  mappings: FileMapping[],
): Promise<string[]> => {
  const { isSymlink } = await import("../utils/fs.js");
  const { expandPath } = await import("../utils/paths.js");
  const { join } = await import("path");

  const initialValues: string[] = [];

  for (const option of optionsWithLabels) {
    const parts = option.value.split(":");

    if (parts.length === 3) {
      // Individual file from selective mapping
      const mapping = mappings.find(
        (m) =>
          m.source === parts[0] &&
          m.target === parts[1] &&
          m.type === "selective",
      );
      if (mapping) {
        const targetPath = join(expandPath(mapping.target), parts[2]);
        if (await isSymlink(targetPath)) {
          initialValues.push(option.value);
        }
      }
    } else if (parts.length === 2) {
      // Regular file or directory mapping
      const targetPath = expandPath(parts[1]);
      if (await isSymlink(targetPath)) {
        initialValues.push(option.value);
      }
    }
  }

  return initialValues;
};

const processSelectedValues = (
  selectedValues: string[],
  mappings: FileMapping[],
): FileMapping[] => {
  const selectedMappings: FileMapping[] = [];
  const selectiveMap = new Map<string, Set<string>>();

  // Process selected values
  for (const value of selectedValues) {
    const parts = value.split(":");

    if (parts.length === 3) {
      // Individual file from selective mapping
      const key = `${parts[0]}:${parts[1]}`;
      if (!selectiveMap.has(key)) {
        selectiveMap.set(key, new Set());
      }
      const fileSet = selectiveMap.get(key);
      if (fileSet) {
        fileSet.add(parts[2]);
      }
    } else if (parts.length === 2) {
      // File or directory mapping
      const mapping = mappings.find(
        (m) =>
          m.source === parts[0] &&
          m.target === parts[1] &&
          m.type !== "selective",
      );
      if (mapping) {
        selectedMappings.push(mapping);
      }
    }
  }

  // Create selective mappings from selected files
  for (const [key, files] of selectiveMap.entries()) {
    const [source, target] = key.split(":");
    const originalMapping = mappings.find(
      (m) =>
        m.source === source && m.target === target && m.type === "selective",
    );

    if (originalMapping) {
      const selectedFiles = [...files];
      const newMapping: FileMapping = {
        ...originalMapping,
        include: selectedFiles,
      };

      // Filter permissions if necessary
      if (
        originalMapping.permissions &&
        typeof originalMapping.permissions === "object"
      ) {
        const filteredPermissions: { [key: string]: string } = {};
        for (const file of selectedFiles) {
          if (file in originalMapping.permissions) {
            filteredPermissions[file] = originalMapping.permissions[file];
          }
        }
        if (Object.keys(filteredPermissions).length > 0) {
          newMapping.permissions = filteredPermissions;
        }
      }

      selectedMappings.push(newMapping);
    }
  }

  return selectedMappings;
};

const findDeselectedMappings = (
  initialValues: string[],
  selectedValues: string[],
  mappings: FileMapping[],
): FileMapping[] => {
  const deselectedMappings: FileMapping[] = [];
  const selectedValueSet = new Set(selectedValues);

  // Check for deselected items (were initially selected but now deselected)
  for (const initialValue of initialValues) {
    if (!selectedValueSet.has(initialValue)) {
      const parts = initialValue.split(":");

      if (parts.length === 3) {
        // Individual file from selective mapping was deselected
        const mapping = mappings.find(
          (m) =>
            m.source === parts[0] &&
            m.target === parts[1] &&
            m.type === "selective",
        );
        if (mapping) {
          // Check if this file needs to be added to deselected
          const existingDeselected = deselectedMappings.find(
            (d) => d.source === mapping.source && d.target === mapping.target,
          );
          if (existingDeselected && existingDeselected.include) {
            if (!existingDeselected.include.includes(parts[2])) {
              existingDeselected.include.push(parts[2]);
            }
          } else {
            deselectedMappings.push({
              ...mapping,
              include: [parts[2]],
            });
          }
        }
      } else if (parts.length === 2) {
        // Regular file or directory mapping was deselected
        const mapping = mappings.find(
          (m) =>
            m.source === parts[0] &&
            m.target === parts[1] &&
            m.type !== "selective",
        );
        if (mapping) {
          deselectedMappings.push(mapping);
        }
      }
    }
  }

  return deselectedMappings;
};

export const selectMappings = async (
  mappings: FileMapping[],
  logger: Logger,
): Promise<SelectionResult | undefined> => {
  intro("Select files to create/remove symbolic links");

  const grouped = groupMappingsByType(mappings);
  const optionsWithLabels = buildOptionsWithLabels(grouped);

  // Check existing symlinks to determine initial selection
  const initialValues = await detectExistingSymlinks(
    optionsWithLabels,
    mappings,
  );
  logger.debug(`Found ${initialValues.length} existing symlinks`);

  const selected = await multiselect({
    message: "Select items to install (Space: toggle, Enter: confirm)",
    options: optionsWithLabels,
    required: false,
    initialValues,
  });

  if (isCancel(selected)) {
    cancel("Operation cancelled");
    return undefined;
  }

  const selectedValues = selected as string[];

  if (selectedValues.length === 0) {
    const confirmEmpty = await confirm({
      message: "Nothing selected. Continue anyway?",
    });

    if (isCancel(confirmEmpty) || !confirmEmpty) {
      cancel("Operation cancelled");
      return undefined;
    }

    return { selected: [], deselected: mappings };
  }

  // Process selection results
  const selectedMappings = processSelectedValues(selectedValues, mappings);
  const deselectedMappings = findDeselectedMappings(
    initialValues,
    selectedValues,
    mappings,
  );

  outro(
    `${selectedMappings.length} items selected, ${deselectedMappings.length} items deselected`,
  );

  return { selected: selectedMappings, deselected: deselectedMappings };
};

export const confirmMappingSelection = async (
  result: SelectionResult,
  logger: Logger,
): Promise<boolean> => {
  const selectedGrouped = groupMappingsByType(result.selected);
  const deselectedGrouped = groupMappingsByType(result.deselected);

  if (result.selected.length > 0) {
    logger.info("Items to install:");

    if (selectedGrouped.file.length > 0) {
      logger.info(`  Files: ${selectedGrouped.file.length}`);
      for (const mapping of selectedGrouped.file) {
        logger.info(`    + ${mapping.target}`);
      }
    }

    if (selectedGrouped.directory.length > 0) {
      logger.info(`  Directories: ${selectedGrouped.directory.length}`);
      for (const mapping of selectedGrouped.directory) {
        logger.info(`    + ${mapping.target}`);
      }
    }

    if (selectedGrouped.selective.length > 0) {
      logger.info(`  Selective: ${selectedGrouped.selective.length}`);
      for (const mapping of selectedGrouped.selective) {
        const fileCount = mapping.include?.length || 0;
        logger.info(`    + ${mapping.target} (${fileCount} files)`);
      }
    }
  }

  if (result.deselected.length > 0) {
    logger.info("Items to remove:");

    if (deselectedGrouped.file.length > 0) {
      logger.info(`  Files: ${deselectedGrouped.file.length}`);
      for (const mapping of deselectedGrouped.file) {
        logger.info(`    - ${mapping.target}`);
      }
    }

    if (deselectedGrouped.directory.length > 0) {
      logger.info(`  Directories: ${deselectedGrouped.directory.length}`);
      for (const mapping of deselectedGrouped.directory) {
        logger.info(`    - ${mapping.target}`);
      }
    }

    if (deselectedGrouped.selective.length > 0) {
      logger.info(`  Selective: ${deselectedGrouped.selective.length}`);
      for (const mapping of deselectedGrouped.selective) {
        const fileCount = mapping.include?.length || 0;
        logger.info(`    - ${mapping.target} (${fileCount} files)`);
      }
    }
  }

  const proceed = await confirm({
    message: "Apply these changes?",
  });

  if (isCancel(proceed)) {
    cancel("Operation cancelled");
    return false;
  }

  return proceed as boolean;
};
