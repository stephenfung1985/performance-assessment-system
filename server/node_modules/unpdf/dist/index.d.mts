import { DocumentInitParameters, PDFDocumentProxy } from "./types/src/display/api.js";
import { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import { Metadata } from "./types/src/display/metadata.js";
import * as PDFJS from "./types/src/pdf.js";
//#region src/_internal/canvas.d.ts
interface CanvasFactoryContext {
  canvas?: HTMLCanvasElement | Canvas;
  context?: CanvasRenderingContext2D | SKRSContext2D | null;
}
/**
 * Derived from the PDF.js project by the Mozilla Foundation.
 * @see https://github.com/mozilla/pdf.js/blob/b8de9a372f9bbf7e33adb362eeae5ef1919dba73/src/display/canvas_factory.js#L18
 * @license Apache-2.0
 */
declare class BaseCanvasFactory {
  #private;
  constructor({ enableHWA }?: {
    enableHWA?: boolean | undefined;
  });
  create(width: number, height: number): {
    canvas: Canvas | HTMLCanvasElement;
    context: SKRSContext2D | CanvasRenderingContext2D | null;
  };
  reset({ canvas }: CanvasFactoryContext, width: number, height: number): void;
  destroy(context: CanvasFactoryContext): void;
  _createCanvas(width: number, height: number): HTMLCanvasElement | Canvas;
}
/**
 * Derived from the PDF.js project by the Mozilla Foundation.
 * @see https://github.com/mozilla/pdf.js/blob/b8de9a372f9bbf7e33adb362eeae5ef1919dba73/src/display/canvas_factory.js#L18
 * @license Apache-2.0
 */
declare class DOMCanvasFactory extends BaseCanvasFactory {
  _document: Document;
  constructor({ ownerDocument, enableHWA }?: {
    ownerDocument?: Document | undefined;
    enableHWA?: boolean | undefined;
  });
  _createCanvas(width: number, height: number): HTMLCanvasElement;
}
declare class NodeCanvasFactory extends BaseCanvasFactory {
  constructor({ enableHWA }?: {
    enableHWA?: boolean | undefined;
  });
  _createCanvas(width: number, height: number): Canvas;
}
//#endregion
//#region src/image.d.ts
interface ExtractedImageObject {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  key: string;
}
/**
 * Extracts images from a specific page of a PDF document, including necessary metadata,
 * such as width, height, and calculated color channels.
 */
declare function extractImages$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, pageNumber: number): Promise<ExtractedImageObject[]>;
declare function renderPageAsImage$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, pageNumber: number, options?: {
  canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>;
  /** @default 1.0 */
  scale?: number;
  width?: number;
  height?: number;
  toDataURL?: false;
}): Promise<ArrayBuffer>;
declare function renderPageAsImage$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, pageNumber: number, options: {
  canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>;
  /** @default 1.0 */
  scale?: number;
  width?: number;
  height?: number;
  toDataURL: true;
}): Promise<string>;
export declare function createIsomorphicCanvasFactory(canvasImport?: () => Promise<typeof import('@napi-rs/canvas')>): Promise<typeof DOMCanvasFactory | typeof NodeCanvasFactory>;
//#endregion
//#region src/links.d.ts
declare function extractLinks$1(data: DocumentInitParameters['data'] | PDFDocumentProxy): Promise<{
  totalPages: number;
  links: string[];
}>;
//#endregion
//#region src/meta.d.ts
declare function getMeta$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, options?: {
  parseDates?: boolean;
}): Promise<{
  info: Record<string, any>;
  metadata: Metadata;
}>;
//#endregion
//#region src/text.d.ts
interface StructuredTextItem {
  /** Text content. */
  str: string;
  /** X position in PDF coordinate space (origin: bottom-left). */
  x: number;
  /** Y position in PDF coordinate space (origin: bottom-left). */
  y: number;
  /** Width in device space. */
  width: number;
  /** Height in device space. */
  height: number;
  /** Font size derived from the transformation matrix. */
  fontSize: number;
  /** Font family resolved from the page's style table, empty when unknown. */
  fontFamily: string;
  /** Text direction: `"ltr"`, `"rtl"`, or `"ttb"`. */
  dir: string;
  /** Whether the text item is followed by a line break. */
  hasEOL: boolean;
}
declare function extractTextItems$1(data: DocumentInitParameters['data'] | PDFDocumentProxy): Promise<{
  totalPages: number;
  items: StructuredTextItem[][];
}>;
declare function extractText$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, options?: {
  mergePages?: false;
}): Promise<{
  totalPages: number;
  text: string[];
}>;
declare function extractText$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, options: {
  mergePages: true;
}): Promise<{
  totalPages: number;
  text: string;
}>;
declare function extractText$1(data: DocumentInitParameters['data'] | PDFDocumentProxy, options?: {
  mergePages?: boolean;
}): Promise<{
  totalPages: number;
  text: string | string[];
}>;
//#endregion
//#region src/config.d.ts
/**
 * Sets the PDF.js build every other method uses – call it before any of them.
 * Without it, the serverless build is used.
 *
 * @example
 * // In Node.js, the legacy build of `pdfjs-dist` (install it first)
 * import { definePDFJSModule } from 'unpdf'
 *
 * await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
 */
export declare function definePDFJSModule(pdfjs: () => Promise<any>): Promise<void>;
/** @deprecated Use `definePDFJSModule` instead. Will be removed in v2. */
export declare function configureUnPDF(options: {
  pdfjs?: () => Promise<any>;
}): Promise<void>;
//#endregion
//#region src/utils.d.ts
/**
 * Creates a `PDFDocumentProxy` from binary PDF data.
 *
 * Applies the following defaults:
 * - `useSystemFonts: true`
 *
 * In Node.js environments, additionally applies:
 * - `disableFontFace: true`
 * - `standardFontDataUrl` resolved from the local `pdfjs-dist` package
 * - `cMapUrl` and `cMapPacked` resolved from the local `pdfjs-dist` package
 */
export declare function getDocumentProxy(data: DocumentInitParameters['data'], options?: DocumentInitParameters): Promise<PDFDocumentProxy>;
export declare function getResolvedPDFJS(): Promise<typeof PDFJS>;
export declare function resolvePDFJSImport(pdfjsResolver?: () => Promise<any>, { reload }?: {
  reload?: boolean | undefined;
}): Promise<void>;
//#endregion
//#region src/index.d.ts
export declare const getMeta: typeof getMeta$1;
export declare const extractText: typeof extractText$1;
export declare const extractTextItems: typeof extractTextItems$1;
export declare const extractImages: typeof extractImages$1;
export declare const renderPageAsImage: typeof renderPageAsImage$1;
export declare const extractLinks: typeof extractLinks$1;
//#endregion
export type { StructuredTextItem };