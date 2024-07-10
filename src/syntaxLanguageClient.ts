'use strict'
import {LanguageClient, LanguageClientOptions, ServerOptions, StreamInfo} from 'coc.nvim'
import * as net from 'net'
import {DidChangeConfigurationNotification} from 'vscode-languageserver-protocol'
import {apiManager} from './apiManager'
import {ClientErrorHandler} from './clientErrorHandler'
import {ClientStatus} from './extension.api'
import {createLogger} from './log'
import {OutputInfoCollector} from './outputInfoCollector'
import {StatusNotification} from './protocol'
import {ServerMode} from './settings'
import {getJavaConfig} from './utils'

const extensionName = "Language Support for Java (Syntax Server)"

export class SyntaxLanguageClient {
    private languageClient: LanguageClient
    private status: ClientStatus = ClientStatus.uninitialized;

    public initialize(requirements, clientOptions: LanguageClientOptions, serverOptions?: ServerOptions) {
        const newClientOptions: LanguageClientOptions = Object.assign({}, clientOptions, {
            middleware: {
                workspace: {
                    didChangeConfiguration: () => {
                        this.languageClient.sendNotification(DidChangeConfigurationNotification.type as any, {
                            settings: {
                                java: getJavaConfig(requirements.java_home),
                            }
                        })
                    }
                }
            },
            errorHandler: new ClientErrorHandler(extensionName),
            initializationFailedHandler: error => {
                createLogger().error(`Failed to initialize ${extensionName} due to ${error && error.toString()}`)
                return true
            },
            outputChannel: new OutputInfoCollector('java-syntax'),
            outputChannelName: 'java-syntax'
        })

        const lsPort = process.env['SYNTAXLS_CLIENT_PORT']
        if (!serverOptions && lsPort) {
            serverOptions = () => {
                const socket = net.connect(lsPort)
                const result: StreamInfo = {
                    writer: socket,
                    reader: socket
                }
                return Promise.resolve(result)
            }
        }

        if (serverOptions) {
            this.languageClient = new LanguageClient('java', extensionName, serverOptions, newClientOptions)

            // TODO: Currently only resolve the promise when the server mode is explicitly set to lightweight.
            // This is to avoid breakings
            this.languageClient.onReady().then(() => {
                this.languageClient.onNotification(StatusNotification.type, (report) => {
                    switch (report.type) {
                        case 'Started':
                            this.status = ClientStatus.started
                            apiManager.updateStatus(ClientStatus.started)
                            // Disable the client-side snippet provider since LS is ready.
                            // snippetCompletionProvider.dispose()
                            break
                        case 'Error':
                            this.status = ClientStatus.error
                            apiManager.updateStatus(ClientStatus.error)
                            break
                        default:
                            break
                    } if (apiManager.getApiInstance().serverMode === ServerMode.lightWeight) {
                        apiManager.fireDidServerModeChange(ServerMode.lightWeight)
                    }
                })
            })
        }

        this.status = ClientStatus.initialized
    }

    public start(): void {
        if (this.languageClient) {
            this.languageClient.start()
            this.status = ClientStatus.starting
        }
    }

    public stop(): Promise<void> {
        this.status = ClientStatus.stopping
        if (this.languageClient) {
            try {
                return this.languageClient.stop()
            } finally {
                this.languageClient = null
            }
        }
        return Promise.resolve()
    }

    public isAlive(): boolean {
        return !!this.languageClient && this.status !== ClientStatus.stopping
    }

    public getClient(): LanguageClient {
        return this.languageClient
    }
}
