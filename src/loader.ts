/**
 * This file contains a Webpack loader for Linaria.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import fs from 'fs';
import path from 'path';
import mkdirp from 'mkdirp';
import normalize from 'normalize-path';
import loaderUtils from 'loader-utils';
import enhancedResolve from 'enhanced-resolve';
import findYarnWorkspaceRoot from 'find-yarn-workspace-root';
import { RawSourceMap } from 'source-map';
import * as EvalCache from './babel/eval-cache';
import Module from './babel/module';
import { debug } from './babel/utils/logger';
import transform from './transform';
import cosmiconfig from 'cosmiconfig';

const workspaceRoot = findYarnWorkspaceRoot();
const lernaConfig = cosmiconfig('lerna', {
  searchPlaces: ['lerna.json'],
}).searchSync();
const lernaRoot =
  lernaConfig !== null ? path.dirname(lernaConfig.filepath) : null;

type LoaderContext = Parameters<typeof loaderUtils.getOptions>[0];

export default function loader(
  this: LoaderContext,
  content: string,
  inputSourceMap: RawSourceMap | null
) {
  debug('loader', this.resourcePath);

  EvalCache.clearForFile(this.resourcePath);

  const {
    sourceMap = undefined,
    cacheDirectory = '.linaria-cache',
    preprocessor = undefined,
    extension = '.linaria.css',
    ...rest
  } = loaderUtils.getOptions(this) || {};

  const root = workspaceRoot || lernaRoot || process.cwd();

  const baseOutputFileName = this.resourcePath.replace(/\.[^.]+$/, extension);

  const outputFilename = normalize(
    path.join(
      path.isAbsolute(cacheDirectory)
        ? cacheDirectory
        : path.join(process.cwd(), cacheDirectory),
      this.resourcePath.includes(root)
        ? path.relative(root, baseOutputFileName)
        : baseOutputFileName
    )
  );

  const resolveOptions = {
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.json'],
  };

  const resolveSync = enhancedResolve.create.sync(
    // this._compilation is a deprecated API
    // However there seems to be no other way to access webpack's resolver
    // There is this.resolve, but it's asynchronous
    // Another option is to read the webpack.config.js, but it won't work for programmatic usage
    // This API is used by many loaders/plugins, so hope we're safe for a while
    this._compilation && this._compilation.options.resolve
      ? {
          ...resolveOptions,
          alias: this._compilation.options.resolve.alias,
          modules: this._compilation.options.resolve.modules,
        }
      : resolveOptions
  );

  let result;

  const originalResolveFilename = Module._resolveFilename;

  try {
    // Use webpack's resolution when evaluating modules
    Module._resolveFilename = (id, { filename }) =>
      resolveSync(path.dirname(filename), id);

    result = transform(content, {
      filename: path.relative(process.cwd(), this.resourcePath),
      inputSourceMap: inputSourceMap ?? undefined,
      outputFilename,
      pluginOptions: rest,
      preprocessor,
    });
  } finally {
    // Restore original behaviour
    Module._resolveFilename = originalResolveFilename;
  }

  if (result.cssText) {
    let { cssText } = result;

    if (sourceMap) {
      cssText += `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
        result.cssSourceMapText || ''
      ).toString('base64')}*/`;
    }

    if (result.dependencies && result.dependencies.length) {
      result.dependencies.forEach(dep => {
        try {
          const f = resolveSync(path.dirname(this.resourcePath), dep);

          this.addDependency(f);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[linaria] failed to add dependency for: ${dep}`, e);
        }
      });
    }

    // Read the file first to compare the content
    // Write the new content only if it's changed
    // This will prevent unnecessary WDS reloads
    let currentCssText;

    try {
      currentCssText = fs.readFileSync(outputFilename, 'utf-8');
    } catch (e) {
      // Ignore error
    }

    if (currentCssText !== cssText) {
      mkdirp.sync(path.dirname(outputFilename));
      fs.writeFileSync(outputFilename, cssText);
    }

    this.callback(
      null,
      `${result.code}\n\nrequire(${loaderUtils.stringifyRequest(
        this,
        outputFilename
      )});`,
      result.sourceMap ?? undefined
    );
    return;
  }

  this.callback(null, result.code, result.sourceMap ?? undefined);
}
