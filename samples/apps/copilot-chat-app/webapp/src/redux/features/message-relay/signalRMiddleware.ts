// Copyright (c) Microsoft. All rights reserved.

import * as signalR from "@microsoft/signalr";
import { AlertType } from "../../../libs/models/AlertType";
import { IChatUser } from "../../../libs/models/ChatUser";
import { IAskResult } from "../../../libs/semantic-kernel/model/AskResult";
import { addAlert } from "../app/appSlice";
import { AuthorRoles, ChatMessageState, IChatMessage } from './../../../libs/models/ChatMessage';
import { isPlan } from './../../../libs/utils/PlanUtils';
import { getSelectedChatID } from './../../app/store';
import { FileUploadedAlert } from './../conversations/ChatState';

// These have to match the callback names used in the backend
const receiveMessageFromServerCallbackName = "ReceiveMessage" as string;
const receiveResponseFromServerCallbackName = "ReceiveResponse" as string;
const userJoinedFromServerCallbackName = "UserJoined" as string;
const receiveUserTypingStateFromServerCallbackName = "ReceiveUserTypingState" as string;
const receiveBotTypingStateFromServerCallbackName = "ReceiveBotTypingState" as string;
const receiveFileUploadedAlertFromServerCallbackName = "ReceiveFileUploadedEvent" as string;

// Set up a SignalR connection to the messageRelayHub on the server
const setupSignalRConnectionToChatHub = () => {
    const connectionHubUrl = new URL("/messageRelayHub", process.env.REACT_APP_BACKEND_URI as string);
    const signalRConnectionOptions = {
        skipNegotiation: true,
        transport: signalR.HttpTransportType.WebSockets,
        logger: signalR.LogLevel.Warning
    };

    // Create the connection instance
    // withAutomaticReconnect will automatically try to reconnect and generate a new socket connection if needed
    var hubConnection = new signalR.HubConnectionBuilder()
        .withUrl(connectionHubUrl.toString(), signalRConnectionOptions)
        .withAutomaticReconnect()
        .withHubProtocol(new signalR.JsonHubProtocol())
        .configureLogging(signalR.LogLevel.Information)
        .build();

    // Note: to keep the connection open the serverTimeout should be
    // larger than the KeepAlive value that is set on the server
    // keepAliveIntervalInMilliseconds default is 15000 and we are using default
    // serverTimeoutInMilliseconds default is 30000 and we are using 60000 set below
    hubConnection.serverTimeoutInMilliseconds = 60000;

    return hubConnection;
};

const hubConnection = setupSignalRConnectionToChatHub();

const registerCommonSignalConnectionEvents = async (store: any) => {
    // Re-establish the connection if connection dropped
    hubConnection.onclose((error: any) => {
        if (hubConnection.state === signalR.HubConnectionState.Disconnected) {
            const errorMessage = 'Connection closed due to error. Try refreshing this page to restart the connection';
            store.dispatch(addAlert({ message: errorMessage, type: AlertType.Error }));
            console.log(errorMessage, error);
        }
    });

    hubConnection.onreconnecting((error: any) => {
        if (hubConnection.state === signalR.HubConnectionState.Reconnecting) {
            const errorMessage = 'Connection lost due to error. Reconnecting...';
            store.dispatch(addAlert({ message: errorMessage, type: AlertType.Info }));
            console.log(errorMessage, error);
        }
    });

    hubConnection.onreconnected((connectionId: any) => {
        if (hubConnection.state === signalR.HubConnectionState.Connected) {
            const message = 'Connection reestablished.';
            store.dispatch(addAlert({ message: message, type: AlertType.Success }));
            console.log(message +  ` Connected with connectionId ${connectionId}`);
        }
    });
}

export const startSignalRConnection = async (store: any) => {
    try {
        registerCommonSignalConnectionEvents(store);
        await hubConnection.start();
        console.assert(hubConnection.state === signalR.HubConnectionState.Connected);
        console.log('SignalR connection established');
    } catch (err) {
        console.assert(hubConnection.state === signalR.HubConnectionState.Disconnected);
        console.error('SignalR Connection Error: ', err);
        setTimeout(() => startSignalRConnection(store), 5000);
    }
};

export const signalRMiddleware = (store: any) => {
    return (next: any) => async (action: any) => {
        // Call the next dispatch method in the middleware chain before performing any async logic
        const result = next(action);

        // The following actions will be captured by the SignalR middleware and broadcasted to all clients.
        switch (action.type) {
            case "conversations/updateConversationFromUser":
                hubConnection.invoke("SendMessageAsync", getSelectedChatID(), action.payload.message)
                    .catch(err => store.dispatch(addAlert({ message: err, type: AlertType.Error })));
                break;
            case "conversations/updateUserIsTyping":
                const { userId, isTyping } = action.payload;
                hubConnection.invoke("SendUserTypingStateAsync", getSelectedChatID(), userId, isTyping)
                    .catch(err => store.dispatch(addAlert({ message: err, type: AlertType.Error })));
                break;
            case "conversations/updateFileUploadedFromUser":
                hubConnection.invoke("SendFileUploadedEventAsync", getSelectedChatID(), action.payload)
                    .catch(err => store.dispatch(addAlert({ message: err, type: AlertType.Error })));
                break;
            case "conversations/setConversations":
                Promise.all(Object.keys(action.payload).map(async (id) => {
                    await hubConnection.invoke("AddClientToGroupAsync", id);
                }))
                    .catch(err => store.dispatch(addAlert({ message: err, type: AlertType.Error })));
                break;
            case "conversations/addConversation":
                hubConnection.invoke("AddClientToGroupAsync", action.payload.id)
                    .catch(err => store.dispatch(addAlert({ message: err, type: AlertType.Error })));
                break;
        }

        return result;
    }
};

export const registerSignalREvents = async (store: any) => {
    hubConnection.on(receiveMessageFromServerCallbackName, (message: IChatMessage, chatId: string) => {
        store.dispatch({ type: "conversations/updateConversationFromServer", payload: { message, chatId } });
    });

    hubConnection.on(receiveResponseFromServerCallbackName, (askResult: IAskResult, chatId: string) => {
        const loggedInUserId = store.getState().conversations.loggedInUserId;
        const originalMessageUserId = askResult.variables.find((v) => v.key === 'userId')?.value;
        const isPlanForLoggedInUser = loggedInUserId === originalMessageUserId;

        const message = {
            timestamp: new Date().getTime(),
            userName: 'bot',
            userId: 'bot',
            content: askResult.value,
            authorRole: AuthorRoles.Bot,
            prompt: askResult.variables.find((v) => v.key === 'prompt')?.value,
            state: (isPlan(askResult.value) && isPlanForLoggedInUser)
                ? ChatMessageState.PlanApprovalRequired : ChatMessageState.NoOp,
        } as IChatMessage;

        store.dispatch({ type: "conversations/updateConversationFromServer", payload: { message, chatId } });
    });

    hubConnection.on(userJoinedFromServerCallbackName, (chatId: string, userId: string) => {
        const user = {
            id: userId,
            online: false,
            fullName: '',
            emailAddress: '',
            isTyping: false,
        } as IChatUser;
        store.dispatch({ type: "conversations/addUserToConversation", payload: { user, chatId } });
    });

    hubConnection.on(receiveUserTypingStateFromServerCallbackName, (chatId: string, userId: string, isTyping: boolean) => {
        store.dispatch({ type: "conversations/updateUserIsTypingFromServer", payload: { chatId, userId, isTyping } });
    });

    hubConnection.on(receiveBotTypingStateFromServerCallbackName, (chatId: string, isTyping: boolean) => {
        store.dispatch({ type: "conversations/updateBotIsTypingFromServer", payload: { chatId, isTyping } });
    });

    hubConnection.on(receiveFileUploadedAlertFromServerCallbackName, ( docUploadedAlert: FileUploadedAlert) => {
        const alertMessage = `${docUploadedAlert.fileOwner} uploaded ${docUploadedAlert.fileName} to the chat`;
        store.dispatch(addAlert({ message: alertMessage, type: AlertType.Success }));
    }); 
};