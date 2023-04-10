import glob from 'fast-glob';
import { cyan } from 'kleur/colors';
import type fsMod from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePath, type ViteDevServer } from 'vite';
import type { AstroSettings, ContentEntryType } from '../@types/astro.js';
import { AstroError, AstroErrorData } from '../core/errors/index.js';
import { info, warn, type LogOptions } from '../core/logger/core.js';
import { isRelativePath } from '../core/path.js';
import { CONTENT_TYPES_FILE } from './consts.js';
import {
	getContentEntryExts,
	getContentPaths,
	getContentEntryIdAndSlug,
	getEntrySlug,
	getEntryType,
	loadContentConfig,
	parseFrontmatter,
	type ContentConfig,
	type ContentObservable,
	type ContentPaths,
	getEntryCollectionName,
	getDataEntryExts,
	getDataEntryId,
} from './utils.js';

type ChokidarEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
type RawContentEvent = { name: ChokidarEvent; entry: string };
type ContentEvent = { name: ChokidarEvent; entry: URL };

type ContentEntryMetadata = { type: 'content'; slug: string };
type DataEntryMetadata = { type: 'data' };
type EntryMetadata = ContentEntryMetadata | DataEntryMetadata;
type CollectionTypes = Record<string, Record<string, EntryMetadata>>;

type CreateContentGeneratorParams = {
	contentConfigObserver: ContentObservable;
	logging: LogOptions;
	settings: AstroSettings;
	/** This is required for loading the content config */
	viteServer: ViteDevServer;
	fs: typeof fsMod;
};

type EventOpts = { logLevel: 'info' | 'warn' };

type EventWithOptions = {
	type: ContentEvent;
	opts: EventOpts | undefined;
};

class UnsupportedFileTypeError extends Error {}

export async function createContentTypesGenerator({
	contentConfigObserver,
	fs,
	logging,
	settings,
	viteServer,
}: CreateContentGeneratorParams) {
	const collectionTypes: CollectionTypes = {};
	const contentPaths = getContentPaths(settings.config, fs);
	const contentEntryExts = getContentEntryExts(settings);
	const dataEntryExts = getDataEntryExts(settings);

	let events: EventWithOptions[] = [];
	let debounceTimeout: NodeJS.Timeout | undefined;

	const typeTemplateContent = await fs.promises.readFile(contentPaths.typesTemplate, 'utf-8');

	async function init(): Promise<
		{ typesGenerated: true } | { typesGenerated: false; reason: 'no-content-dir' }
	> {
		if (!fs.existsSync(contentPaths.contentDir)) {
			return { typesGenerated: false, reason: 'no-content-dir' };
		}

		events.push({
			type: { name: 'add', entry: contentPaths.config.url },
			opts: { logLevel: 'warn' },
		});

		const globResult = await glob('**', {
			cwd: fileURLToPath(contentPaths.contentDir),
			fs: {
				readdir: fs.readdir.bind(fs),
				readdirSync: fs.readdirSync.bind(fs),
			},
		});
		const entries = globResult
			.map((e) => new URL(e, contentPaths.contentDir))
			.filter(
				// Config loading handled first. Avoid running twice.
				(e) => !e.href.startsWith(contentPaths.config.url.href)
			);
		for (const entry of entries) {
			events.push({ type: { name: 'add', entry }, opts: { logLevel: 'warn' } });
		}
		await runEvents();
		return { typesGenerated: true };
	}

	async function handleEvent(
		event: ContentEvent,
		opts?: EventOpts
	): Promise<{ shouldGenerateTypes: boolean; error?: Error }> {
		const logLevel = opts?.logLevel ?? 'info';

		if (event.name === 'addDir' || event.name === 'unlinkDir') {
			const collection = normalizePath(
				path.relative(fileURLToPath(contentPaths.contentDir), fileURLToPath(event.entry))
			);
			// If directory is multiple levels deep, it is not a collection. Ignore event.
			const isCollectionEvent = collection.split('/').length === 1;
			if (!isCollectionEvent) return { shouldGenerateTypes: false };
			switch (event.name) {
				case 'addDir':
					addCollection(collectionTypes, JSON.stringify(collection));
					if (logLevel === 'info') {
						info(logging, 'content', `${cyan(collection)} collection added`);
					}
					break;
				case 'unlinkDir':
					removeCollection(collectionTypes, JSON.stringify(collection));
					break;
			}
			return { shouldGenerateTypes: true };
		}
		const fileType = getEntryType(
			fileURLToPath(event.entry),
			contentPaths,
			contentEntryExts,
			dataEntryExts
		);
		if (fileType === 'ignored') {
			return { shouldGenerateTypes: false };
		}
		if (fileType === 'config') {
			contentConfigObserver.set({ status: 'loading' });
			try {
				const config = await loadContentConfig({ fs, settings, viteServer });
				console.log({ config });
				if (config) {
					contentConfigObserver.set({ status: 'loaded', config });
				} else {
					contentConfigObserver.set({ status: 'does-not-exist' });
				}
			} catch (e) {
				contentConfigObserver.set({
					status: 'error',
					error:
						e instanceof Error ? e : new AstroError(AstroErrorData.UnknownContentCollectionError),
				});
			}

			return { shouldGenerateTypes: true };
		}
		if (fileType === 'unsupported') {
			// Avoid warning if file was deleted.
			if (event.name === 'unlink') {
				return { shouldGenerateTypes: false };
			}
			const { id } = getContentEntryIdAndSlug({
				entry: event.entry,
				contentDir: contentPaths.contentDir,
				collection: '',
			});
			return {
				shouldGenerateTypes: false,
				error: new UnsupportedFileTypeError(id),
			};
		}

		const { entry } = event;
		const { contentDir } = contentPaths;

		const collection = getEntryCollectionName({ entry, contentDir });
		if (collection === undefined) {
			if (['info', 'warn'].includes(logLevel)) {
				warn(
					logging,
					'content',
					`${cyan(
						normalizePath(
							path.relative(fileURLToPath(contentPaths.contentDir), fileURLToPath(event.entry))
						)
					)} must be nested in a collection directory. Skipping.`
				);
			}
			return { shouldGenerateTypes: false };
		}

		if (fileType === 'data') {
			const id = getDataEntryId({ entry, contentDir, collection });
			const collectionKey = JSON.stringify(collection);
			const entryKey = JSON.stringify(id);

			switch (event.name) {
				case 'add':
					if (!(collectionKey in collectionTypes)) {
						addCollection(collectionTypes, collectionKey);
					}
					if (!(entryKey in collectionTypes[collectionKey])) {
						setEntry(collectionTypes, collectionKey, entryKey, { type: 'data' });
					}
					return { shouldGenerateTypes: true };
				case 'unlink':
					if (collectionKey in collectionTypes && entryKey in collectionTypes[collectionKey]) {
						removeEntry(collectionTypes, collectionKey, entryKey);
					}
					return { shouldGenerateTypes: true };
				case 'change':
					return { shouldGenerateTypes: false };
			}
		}

		const { id, slug } = getContentEntryIdAndSlug({ entry, contentDir, collection });

		const collectionKey = JSON.stringify(collection);
		const entryKey = JSON.stringify(id);

		switch (event.name) {
			case 'add':
				const addedSlug = await parseSlug({ fs, event, id, slug, collection });
				if (!(collectionKey in collectionTypes)) {
					addCollection(collectionTypes, collectionKey);
				}
				if (!(entryKey in collectionTypes[collectionKey])) {
					setEntry(collectionTypes, collectionKey, entryKey, { type: 'content', slug: addedSlug });
				}
				return { shouldGenerateTypes: true };
			case 'unlink':
				if (collectionKey in collectionTypes && entryKey in collectionTypes[collectionKey]) {
					removeEntry(collectionTypes, collectionKey, entryKey);
				}
				return { shouldGenerateTypes: true };
			case 'change':
				// User may modify `slug` in their frontmatter.
				// Only regen types if this change is detected.
				const changedSlug = await parseSlug({ fs, event, id, slug, collection });
				const entryMetadata = collectionTypes[collectionKey]?.[entryKey];
				if (entryMetadata?.type === 'content' && entryMetadata?.slug !== changedSlug) {
					setEntry(collectionTypes, collectionKey, entryKey, {
						type: 'content',
						slug: changedSlug,
					});
					return { shouldGenerateTypes: true };
				}
				return { shouldGenerateTypes: false };
		}
	}

	function queueEvent(rawEvent: RawContentEvent, opts?: EventOpts) {
		const event = {
			type: {
				entry: pathToFileURL(rawEvent.entry),
				name: rawEvent.name,
			},
			opts,
		};
		if (!event.type.entry.pathname.startsWith(contentPaths.contentDir.pathname)) return;

		events.push(event);

		debounceTimeout && clearTimeout(debounceTimeout);
		const runEventsSafe = async () => {
			try {
				await runEvents(opts);
			} catch {
				// Prevent frontmatter errors from crashing the server. The errors
				// are still reported on page reflects as desired.
				// Errors still crash dev from *starting*.
			}
		};
		debounceTimeout = setTimeout(runEventsSafe, 50 /* debounce to batch chokidar events */);
	}

	async function runEvents(opts?: EventOpts) {
		const logLevel = opts?.logLevel ?? 'info';
		const eventResponses = [];

		for (const event of events) {
			const response = await handleEvent(event.type, event.opts);
			eventResponses.push(response);
		}

		events = [];
		let unsupportedFiles = [];
		for (const response of eventResponses) {
			if (response.error instanceof UnsupportedFileTypeError) {
				unsupportedFiles.push(response.error.message);
			}
		}
		if (unsupportedFiles.length > 0 && ['info', 'warn'].includes(logLevel)) {
			warn(
				logging,
				'content',
				`Unsupported file types found. Prefix with an underscore (\`_\`) to ignore:\n- ${unsupportedFiles.join(
					'\n'
				)}`
			);
		}
		const observable = contentConfigObserver.get();
		if (eventResponses.some((r) => r.shouldGenerateTypes)) {
			await writeContentFiles({
				fs,
				contentTypes: collectionTypes,
				contentPaths,
				typeTemplateContent,
				contentConfig: observable.status === 'loaded' ? observable.config : undefined,
				contentEntryTypes: settings.contentEntryTypes,
			});
			if (observable.status === 'loaded' && ['info', 'warn'].includes(logLevel)) {
				warnNonexistentCollections({
					logging,
					contentConfig: observable.config,
					contentTypes: collectionTypes,
				});
			}
		}
	}
	return { init, queueEvent };
}

function addCollection(contentMap: CollectionTypes, collectionKey: string) {
	contentMap[collectionKey] = {};
}

function removeCollection(contentMap: CollectionTypes, collectionKey: string) {
	delete contentMap[collectionKey];
}

async function parseSlug({
	fs,
	event,
	id,
	slug,
	collection,
}: {
	fs: typeof fsMod;
	event: ContentEvent;
	id: string;
	slug: string;
	collection: string;
}) {
	// `slug` may be present in entry frontmatter.
	// This should be respected by the generated `slug` type!
	// Parse frontmatter and retrieve `slug` value for this.
	// Note: will raise any YAML exceptions and `slug` parse errors (i.e. `slug` is a boolean)
	// on dev server startup or production build init.
	const rawContents = await fs.promises.readFile(event.entry, 'utf-8');
	const { data: frontmatter } = parseFrontmatter(rawContents, fileURLToPath(event.entry));
	return getEntrySlug({ id, slug, collection, unvalidatedSlug: frontmatter.slug });
}

function setEntry(
	contentTypes: CollectionTypes,
	collectionKey: string,
	entryKey: string,
	metadata: EntryMetadata
) {
	contentTypes[collectionKey][entryKey] = metadata;
}

function removeEntry(contentTypes: CollectionTypes, collectionKey: string, entryKey: string) {
	delete contentTypes[collectionKey][entryKey];
}

async function writeContentFiles({
	fs,
	contentPaths,
	contentTypes,
	typeTemplateContent,
	contentEntryTypes,
	contentConfig,
}: {
	fs: typeof fsMod;
	contentPaths: ContentPaths;
	contentTypes: CollectionTypes;
	typeTemplateContent: string;
	contentEntryTypes: ContentEntryType[];
	contentConfig?: ContentConfig;
}) {
	let contentTypesStr = '';
	const collectionKeys = Object.keys(contentTypes).sort();
	for (const collectionKey of collectionKeys) {
		const collectionConfig = contentConfig?.collections[JSON.parse(collectionKey)];
		contentTypesStr += `${collectionKey}: {\n`;
		const entryKeys = Object.keys(contentTypes[collectionKey]).sort();
		for (const entryKey of entryKeys) {
			const entryMetadata = contentTypes[collectionKey][entryKey];
			const dataType = collectionConfig?.schema ? `InferEntrySchema<${collectionKey}>` : 'any';
			if (entryMetadata.type === 'data') {
				contentTypesStr += `${entryKey}: {\n	type: 'data',\n	id: ${entryKey},\n	collection: ${collectionKey},\n	data: ${dataType}\n},\n`;
			} else {
				const renderType = `{ render(): Render[${JSON.stringify(
					path.extname(JSON.parse(entryKey))
				)}] }`;

				const slugType = JSON.stringify(entryMetadata.slug);
				contentTypesStr += `${entryKey}: {\n  type: 'content',\n	id: ${entryKey},\n  slug: ${slugType},\n  body: string,\n  collection: ${collectionKey},\n  data: ${dataType}\n} & ${renderType},\n`;
			}
		}
		contentTypesStr += `},\n`;
	}

	if (!fs.existsSync(contentPaths.cacheDir)) {
		fs.mkdirSync(contentPaths.cacheDir, { recursive: true });
	}

	let configPathRelativeToCacheDir = normalizePath(
		path.relative(contentPaths.cacheDir.pathname, contentPaths.config.url.pathname)
	);
	if (!isRelativePath(configPathRelativeToCacheDir))
		configPathRelativeToCacheDir = './' + configPathRelativeToCacheDir;

	// Remove `.ts` from import path
	if (configPathRelativeToCacheDir.endsWith('.ts')) {
		configPathRelativeToCacheDir = configPathRelativeToCacheDir.replace(/\.ts$/, '');
	}

	for (const contentEntryType of contentEntryTypes) {
		if (contentEntryType.contentModuleTypes) {
			typeTemplateContent = contentEntryType.contentModuleTypes + '\n' + typeTemplateContent;
		}
	}
	typeTemplateContent = typeTemplateContent.replace('// @@ENTRY_MAP@@', contentTypesStr);
	typeTemplateContent = typeTemplateContent.replace(
		"'@@CONTENT_CONFIG_TYPE@@'",
		contentConfig ? `typeof import(${JSON.stringify(configPathRelativeToCacheDir)})` : 'never'
	);

	await fs.promises.writeFile(
		new URL(CONTENT_TYPES_FILE, contentPaths.cacheDir),
		typeTemplateContent
	);
}

function warnNonexistentCollections({
	contentConfig,
	contentTypes,
	logging,
}: {
	contentConfig: ContentConfig;
	contentTypes: CollectionTypes;
	logging: LogOptions;
}) {
	for (const configuredCollection in contentConfig.collections) {
		if (!contentTypes[JSON.stringify(configuredCollection)]) {
			warn(
				logging,
				'content',
				`${JSON.stringify(
					configuredCollection
				)} is not a collection. Check your content config for typos.`
			);
		}
	}
}
