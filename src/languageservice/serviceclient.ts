/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { ExtensionContext, workspace, languages } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions,
    TransportKind, RequestType, NotificationType, NotificationHandler,
    ErrorAction, CloseAction } from 'vscode-languageclient';

import VscodeWrapper from '../controllers/vscodeWrapper';
import Telemetry from '../models/telemetry';
import * as Utils from '../models/utils';
import {VersionRequest} from '../models/contracts';
import Constants = require('../models/constants');
import ServerProvider from './server';
import ServiceDownloadProvider from './download';
import {ExtensionWrapper, Logger} from './extUtil';
import ExtConfig from  '../configurations/extConfig';
import StatusView from '../views/statusView';
import {Runtime, PlatformInformation} from '../models/platform';

let opener = require('opener');

/**
 * @interface IMessage
 */
interface IMessage {
    jsonrpc: string;
}


/**
 * Handle Language Service client errors
 * @class LanguageClientErrorHandler
 */
class LanguageClientErrorHandler {

    private vscodeWrapper: VscodeWrapper;

    /**
     * Creates an instance of LanguageClientErrorHandler.
     * @memberOf LanguageClientErrorHandler
     */
    constructor() {
        if (!this.vscodeWrapper) {
            this.vscodeWrapper = new VscodeWrapper();
        }
    }

    /**
     * Show an error message prompt with a link to known issues wiki page
     * @memberOf LanguageClientErrorHandler
     */
    showOnErrorPrompt(): void {
        Telemetry.sendTelemetryEvent('SqlToolsServiceCrash');

        this.vscodeWrapper.showErrorMessage(
          Constants.sqlToolsServiceCrashMessage,
          Constants.sqlToolsServiceCrashButton).then(action => {
            if (action && action === Constants.sqlToolsServiceCrashButton) {
                opener(Constants.sqlToolsServiceCrashLink);
            }
        });
    }

    /**
     * Callback for language service client error
     *
     * @param {Error} error
     * @param {Message} message
     * @param {number} count
     * @returns {ErrorAction}
     *
     * @memberOf LanguageClientErrorHandler
     */
    error(error: Error, message: IMessage, count: number): ErrorAction {
        this.showOnErrorPrompt();

        // we don't retry running the service since crashes leave the extension
        // in a bad, unrecovered state
        return ErrorAction.Shutdown;
    }

    /**
     * Callback for language service client closed
     *
     * @returns {CloseAction}
     *
     * @memberOf LanguageClientErrorHandler
     */
    closed(): CloseAction {
        this.showOnErrorPrompt();

        // we don't retry running the service since crashes leave the extension
        // in a bad, unrecovered state
        return CloseAction.DoNotRestart;
    }
}

// The Service Client class handles communication with the VS Code LanguageClient
export default class SqlToolsServiceClient {
    // singleton instance
    private static _instance: SqlToolsServiceClient = undefined;

    // VS Code Language Client
    private _client: LanguageClient = undefined;

    // getter method for the Language Client
    private get client(): LanguageClient {
        return this._client;
    }

    private set client(client: LanguageClient) {
        this._client = client;
    }

    constructor(private _server: ServerProvider) {
    }

    // gets or creates the singleton SQL Tools service client instance
    public static get instance(): SqlToolsServiceClient {
        if (this._instance === undefined) {
            let config = new ExtConfig();
            let logger = new Logger();
            let downloadProvider = new ServiceDownloadProvider(config, logger);
            let statusView = new StatusView();
            let extWrapper = new ExtensionWrapper();
            let serviceProvider = new ServerProvider(downloadProvider, config, statusView, extWrapper);

            this._instance = new SqlToolsServiceClient(serviceProvider);
        }
        return this._instance;
    }

    // initialize the SQL Tools Service Client instance by launching
    // out-of-proc server through the LanguageClient
    public initialize(context: ExtensionContext): Promise<boolean> {
         return PlatformInformation.GetCurrent().then( platformInfo => {
            if (platformInfo.runtimeId === Runtime.UnknownRuntime) {
                throw new Error('Invalid Platform');
            } else {
                return this.initializeService(platformInfo.runtimeId, context);
            }
         });
    }

    /**
     * Initializes the SQL language configuration
     *
     * @memberOf SqlToolsServiceClient
     */
    private initializeLanguageConfiguration(): void {
        languages.setLanguageConfiguration('sql', {
            comments: {
                lineComment: '--',
                blockComment: ['/*', '*/']
            },

            brackets: [
                ['{', '}'],
                ['[', ']'],
                ['(', ')']
            ],

            __characterPairSupport: {
                autoClosingPairs: [
                    { open: '{', close: '}' },
                    { open: '[', close: ']' },
                    { open: '(', close: ')' },
                    { open: '"', close: '"', notIn: ['string'] },
                    { open: '\'', close: '\'', notIn: ['string', 'comment'] }
                ]
            }
        });
    }

    private initializeService(runtime: Runtime, context: ExtensionContext): Promise<boolean> {
        let self = this;

        return new Promise<boolean>( (resolve, reject) => {
            this._server.getServerPath(runtime).then(serverPath => {
                self.initializeLanguageConfiguration();

                let serverArgs = [];
                let serverCommand = serverPath;
                if (serverPath === undefined) {
                    Utils.logDebug(Constants.invalidServiceFilePath);
                    throw new Error(Constants.invalidServiceFilePath);
                } else if (serverPath.endsWith('.dll')) {
                    serverArgs = [serverPath];
                    serverCommand = 'dotnet';
                }

                // Enable diagnostic logging in the service if it is configured
                let config = workspace.getConfiguration(Constants.extensionConfigSectionName);
                if (config) {
                    let logDebugInfo = config[Constants.configLogDebugInfo];
                    if (logDebugInfo) {
                        serverArgs.push('--enable-logging');
                    }
                }

                // run the service host using dotnet.exe from the path
                let serverOptions: ServerOptions = {  command: serverCommand, args: serverArgs, transport: TransportKind.stdio  };

                // Options to control the language client
                let clientOptions: LanguageClientOptions = {
                    documentSelector: ['sql'],
                    synchronize: {
                        configurationSection: 'mssql'
                    },
                    errorHandler: new LanguageClientErrorHandler()
                };

                // cache the client instance for later use
                this.client = new LanguageClient('sqlserverclient', serverOptions, clientOptions);
                this.client.onReady().then( () => {
                    this.checkServiceCompatibility();
                });
                // Create the language client and start the client.
                let disposable = this.client.start();

                // Push the disposable to the context's subscriptions so that the
                // client can be deactivated on extension deactivation
                context.subscriptions.push(disposable);
                resolve(true);

            }).catch(err => {
                Utils.logDebug(Constants.serviceLoadingFailed + ' ' + err );
                Utils.showErrorMsg(Constants.serviceLoadingFailed);
                reject(err);
            });
        });
    }

    /**
     * Send a request to the service client
     * @param type The of the request to make
     * @param params The params to pass with the request
     * @returns A thenable object for when the request receives a response
     */
    public sendRequest<P, R, E>(type: RequestType<P, R, E>, params?: P): Thenable<R> {
        if (this.client !== undefined) {
            return this.client.sendRequest(type, params);
        }
    }

    /**
     * Register a handler for a notification type
     * @param type The notification type to register the handler for
     * @param handler The handler to register
     */
    public onNotification<P>(type: NotificationType<P>, handler: NotificationHandler<P>): void {
        if (this._client !== undefined) {
             return this.client.onNotification(type, handler);
        }
    }

    public checkServiceCompatibility(): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this._client.sendRequest(VersionRequest.type, undefined).then((result) => {
                 Utils.logDebug('sqlserverclient version: ' + result);

                 if (result === undefined || !result.startsWith(Constants.serviceCompatibleVersion)) {
                     Utils.showErrorMsg(Constants.serviceNotCompatibleError);
                     Utils.logDebug(Constants.serviceNotCompatibleError);
                     resolve(false);
                 } else {
                     resolve(true);
                 }
            });
        });
    }
}
