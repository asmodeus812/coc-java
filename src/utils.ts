'use strict'

import {commands, Position, Range, Uri, workspace, WorkspaceConfiguration} from 'coc.nvim'
import * as fs from 'fs'
import * as path from 'path'
import {Commands} from './commands'
import {IJavaRuntime} from 'jdk-utils'
import {sortJdksByVersion, sortJdksBySource, getSupportedJreNames, listJdks} from './requirements'

export function getJavaConfiguration(): WorkspaceConfiguration {
  return workspace.getConfiguration('java')
}

export function isPreferenceOverridden(section: string): boolean {
  const config = workspace.getConfiguration()
  return config.inspect(section).workspaceFolderValue !== undefined ||
    config.inspect(section).workspaceValue !== undefined ||
    config.inspect(section).globalValue !== undefined
}

export function deleteDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach((child) => {
      const entry = path.join(dir, child)
      if (fs.lstatSync(entry).isDirectory()) {
        deleteDirectory(entry)
      } else {
        fs.unlinkSync(entry)
      }
    })
    fs.rmdirSync(dir)
  }
}

export function getTimestamp(file) {
  if (!fs.existsSync(file)) {
    return -1
  }
  const stat = fs.statSync(file)
  return stat.mtimeMs
}

export function ensureExists(folder) {
  if (fs.existsSync(folder)) {
    return
  }
  ensureExists(path.dirname(folder))
  fs.mkdirSync(folder)
}

export function getBuildFilePatterns(): string[] {
  const config = getJavaConfiguration()
  const isMavenImporterEnabled: boolean = config.get<boolean>("import.maven.enabled")
  const isGradleImporterEnabled: boolean = config.get<boolean>("import.gradle.enabled")
  const patterns: string[] = []
  if (isMavenImporterEnabled) {
    patterns.push("**/pom.xml")
  }
  if (isGradleImporterEnabled) {
    patterns.push("**/*.gradle")
    patterns.push("**/*.gradle.kts")
  }

  return patterns
}

export function getInclusionPatternsFromNegatedExclusion(): string[] {
  const config = getJavaConfiguration()
  const exclusions: string[] = config.get<string[]>("import.exclusions", [])
  const patterns: string[] = []
  for (const exclusion of exclusions) {
    if (exclusion.startsWith("!")) {
      patterns.push(exclusion.substr(1))
    }
  }
  return patterns
}

export function convertToGlob(filePatterns: string[], basePatterns?: string[]): string {
  if (!filePatterns || filePatterns.length === 0) {
    return ""
  }

  if (!basePatterns || basePatterns.length === 0) {
    return parseToStringGlob(filePatterns)
  }

  const patterns: string[] = []
  for (const basePattern of basePatterns) {
    for (const filePattern of filePatterns) {
      patterns.push(path.join(basePattern, `/${filePattern}`).replace(/\\/g, "/"))
    }
  }
  return parseToStringGlob(patterns)
}

export function getExclusionBlob(): string {
  const config = getJavaConfiguration()
  const exclusions: string[] = config.get<string[]>("import.exclusions", [])
  const patterns: string[] = []
  for (const exclusion of exclusions) {
    if (exclusion.startsWith("!")) {
      continue
    }

    patterns.push(exclusion)
  }
  return parseToStringGlob(patterns)
}

function parseToStringGlob(patterns: string[]): string {
  if (!patterns || patterns.length === 0) {
    return ""
  }

  return `{${patterns.join(",")}}`
}

/**
 * Get all Java projects from Java Language Server.
 * @param excludeDefaultProject whether the default project should be excluded from the list, defaults to true.
 * @returns string array for the project uris.
 */
export async function getAllJavaProjects(excludeDefaultProject: boolean = true): Promise<string[]> {
  let projectUris: string[] = await commands.executeCommand<string[]>(Commands.EXECUTE_WORKSPACE_COMMAND, Commands.GET_ALL_JAVA_PROJECTS)
  if (excludeDefaultProject) {
    projectUris = projectUris.filter((uriString) => {
      const projectPath = Uri.parse(uriString).fsPath
      return path.basename(projectPath) !== "jdt.ls-java-project"
    })
  }
  return projectUris
}

export async function hasBuildToolConflicts(): Promise<boolean> {
  const projectConfigurationUris: Uri[] = await getBuildFilesInWorkspace()
  const projectConfigurationFsPaths: string[] = projectConfigurationUris.map((uri) => uri.fsPath)
  const eclipseDirectories = getDirectoriesByBuildFile(projectConfigurationFsPaths, [], ".project")
  // ignore the folders that already has .project file (already imported before)
  const gradleDirectories = getDirectoriesByBuildFile(projectConfigurationFsPaths, eclipseDirectories, ".gradle")
  const gradleDirectoriesKts = getDirectoriesByBuildFile(projectConfigurationFsPaths, eclipseDirectories, ".gradle.kts")
  gradleDirectories.concat(gradleDirectoriesKts)
  const mavenDirectories = getDirectoriesByBuildFile(projectConfigurationFsPaths, eclipseDirectories, "pom.xml")
  return gradleDirectories.some((gradleDir) => {
    return mavenDirectories.includes(gradleDir)
  })
}

export async function getBuildFilesInWorkspace(): Promise<Uri[]> {
  const buildFiles: Uri[] = []
  const inclusionFilePatterns: string[] = getBuildFilePatterns()
  inclusionFilePatterns.push("**/.project")
  const inclusionFolderPatterns: string[] = getInclusionPatternsFromNegatedExclusion()
  // Since VS Code API does not support put negated exclusion pattern in findFiles(),
  // here we first parse the negated exclusion to inclusion and do the search.
  if (inclusionFilePatterns.length > 0 && inclusionFolderPatterns.length > 0) {
    buildFiles.push(...await workspace.findFiles(convertToGlob(inclusionFilePatterns, inclusionFolderPatterns), null /* force not use default exclusion */))
  }

  const inclusionBlob: string = convertToGlob(inclusionFilePatterns)
  const exclusionBlob: string = getExclusionBlob()
  if (inclusionBlob) {
    buildFiles.push(...await workspace.findFiles(inclusionBlob, exclusionBlob))
  }

  return buildFiles
}

function getDirectoriesByBuildFile(inclusions: string[], exclusions: string[], fileName: string): string[] {
  return inclusions.filter((fsPath) => fsPath.endsWith(fileName)).map((fsPath) => {
    return path.dirname(fsPath)
  }).filter((inclusion) => {
    return !exclusions.includes(inclusion)
  })
}


export function getJavaConfig(javaHome: string): any {
  const origConfig = getJavaConfiguration()
  const javaConfig = JSON.parse(JSON.stringify(origConfig))
  const editorConfig = workspace.getConfiguration('editor')
  javaConfig.home = javaHome
  // Since source & output path are project specific settings. To avoid pollute other project,
  // we avoid reading the value from the global scope.
  javaConfig.project.outputPath = origConfig.inspect<string>("project.outputPath").workspaceValue
  javaConfig.project.sourcePaths = origConfig.inspect<string[]>("project.sourcePaths").workspaceValue
  javaConfig.format.insertSpaces = editorConfig.get('insertSpaces')
  javaConfig.format.tabSize = editorConfig.get('tabSize')
  const isInsider: boolean = false
  const androidSupport = javaConfig.jdt.ls.androidSupport.enabled
  switch (androidSupport) {
    case "auto":
      javaConfig.jdt.ls.androidSupport.enabled = isInsider
      break
    case "on":
      javaConfig.jdt.ls.androidSupport.enabled = true
      break
    case "off":
      javaConfig.jdt.ls.androidSupport.enabled = false
      break
    default:
      javaConfig.jdt.ls.androidSupport.enabled = false
      break
  }

  const completionCaseMatching = javaConfig.completion.matchCase
  if (completionCaseMatching === "auto") {
    javaConfig.completion.matchCase = isInsider ? "firstLetter" : "off"
  }

  const javacSupport = javaConfig.jdt.ls.javac.enabled
  switch (javacSupport) {
    case "on":
      javaConfig.jdt.ls.javac.enabled = true
      break
    case "off":
      javaConfig.jdt.ls.javac.enabled = false
      break
    default:
      javaConfig.jdt.ls.javac.enabled = false
      break
  }

  if (javaConfig.completion.matchCase === "auto") {
    javaConfig.completion.matchCase = "firstLetter"
  }

  const guessMethodArguments = javaConfig.completion.guessMethodArguments
  if (guessMethodArguments === "auto") {
    javaConfig.completion.guessMethodArguments = isInsider ? "off" : "insertBestGuessedArguments"
  }

  if (!isPreferenceOverridden("java.implementationCodeLens") && typeof javaConfig.implementationsCodeLens?.enabled === 'boolean') {
    const deprecatedImplementations = javaConfig.implementationsCodeLens.enabled
    javaConfig.implementationCodeLens = deprecatedImplementations ? "types" : "none"
  }

  return javaConfig
}

export async function addAutoDetectedJdks(configuredJREs: any[]): Promise<any[]> {
  // search valid JDKs from env.JAVA_HOME, env.PATH, SDKMAN, jEnv, jabba, Common directories
  const autoDetectedJREs: IJavaRuntime[] = await listJdks()
  sortJdksByVersion(autoDetectedJREs)
  sortJdksBySource(autoDetectedJREs)
  const addedJreNames: Set<string> = new Set<string>()
  const supportedJreNames: string[] = getSupportedJreNames()
  for (const jre of configuredJREs) {
    if (jre.name) {
      addedJreNames.add(jre.name)
    }
  }
  for (const jre of autoDetectedJREs) {
    const majorVersion: number = jre.version?.major ?? 0
    if (!majorVersion) {
      continue
    }

    let jreName: string = `JavaSE-${majorVersion}`
    if (majorVersion <= 5) {
      jreName = `J2SE-1.${majorVersion}`
    } else if (majorVersion <= 8) {
      jreName = `JavaSE-1.${majorVersion}`
    }

    if (addedJreNames.has(jreName) || !supportedJreNames?.includes(jreName)) {
      continue
    }

    configuredJREs.push({
      name: jreName,
      path: jre.homedir,
    })

    addedJreNames.add(jreName)
  }

  return configuredJREs
}

export function equals(one: any, other: any): boolean {
  if (one === other) {
    return true
  }
  if (
    one === null ||
    one === undefined ||
    other === null ||
    other === undefined
  ) {
    return false
  }
  if (typeof one !== typeof other) {
    return false
  }
  if (typeof one !== 'object') {
    return false
  }
  if (Array.isArray(one) !== Array.isArray(other)) {
    return false
  }

  let i: number
  let key: string

  if (Array.isArray(one)) {
    if (one.length !== other.length) {
      return false
    }
    for (i = 0; i < one.length; i++) {
      if (!equals(one[i], other[i])) {
        return false
      }
    }
  } else {
    const oneKeys: string[] = []

    for (key in one) {
      oneKeys.push(key)
    }
    oneKeys.sort()
    const otherKeys: string[] = []
    for (key in other) {
      otherKeys.push(key)
    }
    otherKeys.sort()
    if (!equals(oneKeys, otherKeys)) {
      return false
    }
    for (i = 0; i < oneKeys.length; i++) {
      if (!equals(one[oneKeys[i]], other[oneKeys[i]])) {
        return false
      }
    }
  }
  return true
}

/**
 * Check if two ranges have overlap or nested
 */
export function rangeIntersect(r: Range, range: Range): boolean {
  if (positionInRange(r.start, range) == 0) {
    return true
  }
  if (positionInRange(r.end, range) == 0) {
    return true
  }
  if (rangeInRange(range, r)) {
    return true
  }
  return false
}

function rangeInRange(r: Range, range: Range): boolean {
  return positionInRange(r.start, range) === 0 && positionInRange(r.end, range) === 0
}

function positionInRange(position: Position, range: Range): number {
  let {start, end} = range
  if (comparePosition(position, start) < 0) return -1
  if (comparePosition(position, end) > 0) return 1
  return 0
}

function comparePosition(position: Position, other: Position): number {
  if (position.line > other.line) return 1
  if (other.line == position.line && position.character > other.character) return 1
  if (other.line == position.line && position.character == other.character) return 0
  return -1
}
