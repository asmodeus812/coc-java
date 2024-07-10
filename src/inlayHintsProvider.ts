import {CancellationToken, Emitter, InlayHint, InlayHintKind, InlayHintsProvider, LanguageClient, Range, RequestType, TextDocument} from 'coc.nvim'
import * as ls from 'vscode-languageserver-protocol'

export class JavaInlayHintsProvider implements InlayHintsProvider {

    private onDidChange = new Emitter<void>();
    public onDidChangeInlayHints = this.onDidChange.event;

    constructor(private client: LanguageClient) {
        this.client.onRequest(InlayHintRefreshRequest.type, async () => {
            this.onDidChange.fire()
        })
    }

    public async provideInlayHints(document: TextDocument, range: Range, token: CancellationToken): Promise<InlayHint[]> {
        const requestParams: InlayHintParams = {
            textDocument: {uri: document.uri},
            range: range
        }
        try {
            const values = await this.client.sendRequest(InlayHintRequest.type, requestParams, token)
            if (token.isCancellationRequested) {
                return []
            }
            return asInlayHints(values, this.client)
        } catch (error) {
            return this.client.handleFailedRequest(InlayHintRequest.type as any, token, error, [])
        }
    }
}

/**
 * A parameter literal used in inlay hints requests.
 *
 * @since 3.17.0 - proposed state
 */
export type InlayHintParams = /* WorkDoneProgressParams &*/ {
    /**
     * The text document.
     */
    textDocument: ls.TextDocumentIdentifier

    /**
     * The document range for which inlay hints should be computed.
     */
    range: ls.Range
}

/**
 * Inlay hint information.
 *
 * @since 3.17.0 - proposed state
 */
export type LSInlayHint = {

    /**
     * The position of this hint.
     */
    position: ls.Position

    /**
     * The label of this hint. A human readable string or an array of
     * InlayHintLabelPart label parts.
     *
     * *Note* that neither the string nor the label part can be empty.
     */
    label: string // label: string | InlayHintLabelPart[];
}

namespace InlayHintRequest {
    export const type: RequestType<InlayHintParams, LSInlayHint[], any> = new RequestType('textDocument/inlayHint')
}

/**
 * @since 3.17.0 - proposed state
 */
namespace InlayHintRefreshRequest {
    export const type: RequestType<void, void, void> = new RequestType('workspace/inlayHint/refresh')
}

async function asInlayHints(values: LSInlayHint[] | undefined | null, client: LanguageClient,): Promise<InlayHint[] | undefined> {
    if (!Array.isArray(values)) {
        return undefined
    }
    return values.map(lsHint => asInlayHint(lsHint, client))
}

function asInlayHint(value: LSInlayHint, client: LanguageClient): InlayHint {
    const label = value.label
    const result = InlayHint.create(value.position, label)
    result.paddingRight = true
    result.kind = InlayHintKind.Parameter
    return result
}
