import { Injectable, Inject, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { ConnectionState } from './connection-state.enum';
import { ChannelConfig } from './channel-config';
import { ChannelEvent } from './channel-event';
import { ChannelSubject } from './channel-subject';

declare var $;

/**
 * ChannelService is a wrapper around the functionality that SignalR
 * provides to expose the ideas of channels and events. With this service
 * you can subscribe to specific channels (or groups in signalr speak) and
 * use observables to react to specific events sent out on those channels.
 */
@Injectable()
export class ChannelService {
  /**
   * starting$ is an observable available to know if the signalr
   * connection is ready or not. On a successful connection this
   * stream will emit a value.
   */
  starting$: Observable<any>;

  /**
   * connectionState$ provides the current state of the underlying
   * connection as an observable stream.
   */
  connectionState$: Observable<ConnectionState>;

  /**
   * error$ provides a stream of any error messages that occur on the
   * SignalR connection
   */
  error$: Observable<string>;

  // These are used to feed the public observables
  private connectionStateSubject = new Subject<ConnectionState>();
  private startingSubject = new Subject<any>();
  private errorSubject = new Subject<any>();

  // These are used to track the internal SignalR state
  private hubConnection: any;
  private hubProxy: any;

  // An internal array to track what channel subscriptions exist
  private subjects = new Array<ChannelSubject>();

  constructor(
    @Inject('channel.config') private channelConfig: ChannelConfig,
    private ngZone: NgZone
  ) {
    if ($ === undefined || $.hubConnection === undefined) {
      throw new Error('The variable \'$\' or the .hubConnection() function are not defined... please check the SignalR scripts have been loaded properly');
    }

    // Set up our observables
    this.connectionState$ = this.connectionStateSubject.asObservable();
    this.error$ = this.errorSubject.asObservable();
    this.starting$ = this.startingSubject.asObservable();

    this.hubConnection = $.hubConnection();
    this.hubConnection.url = channelConfig.url;
    this.hubProxy = this.hubConnection.createHubProxy(channelConfig.hubName);

    // Define handlers for the connection state events
    this.hubConnection.stateChanged((state: any) => {
      let newState = ConnectionState.Connecting;

      switch (state.newState) {
        case $.signalR.connectionState.connecting:
          newState = ConnectionState.Connecting;
          break;
        case $.signalR.connectionState.connected:
          newState = ConnectionState.Connected;
          break;
        case $.signalR.connectionState.reconnecting:
          newState = ConnectionState.Reconnecting;
          break;
        case $.signalR.connectionState.disconnected:
          newState = ConnectionState.Disconnected;
          break;
      }

      // Push the new state on our subject
      this.connectionStateSubject.next(newState);
    });

    // Define handlers for any errors
    this.hubConnection.error((error: any) => {
      // Push the error on our subject
      this.errorSubject.next(error);
    });

    this.hubProxy.on('onEvent', (channel: string, event: ChannelEvent) => {
      this.ngZone.run(() => {
        // console.log(`onEvent - ${channel} channel`, ev);

        //noinspection TypeScriptUnresolvedFunction
        /**
         * This method acts like a broker for incoming messages. We
         * check the internal array of subjects to see if one exists
         * for the channel this came in on, and then emit the event
         * on it. Otherwise we ignore the message.
         */
        let channelSub = this.subjects.find((x: ChannelSubject) => {
          return x.channel === channel;
        }) as ChannelSubject;

        // If we found a subject then emit the event on it
        if (channelSub !== undefined) {
          return channelSub.subject.next(event);
        }
      });
    });
  }

  /**
   * Start the SignalR connection. The starting$ stream will emit an
   * event if the connection is established, otherwise it will emit an
   * error.
   */
  start(): void {
    /**
     * Now we only want the connection started once, so we have a special
     * starting$ observable that clients can subscribe to know know if
     * if the startup sequence is done.
     *
     * If we just mapped the start() promise to an observable, then any time
     * a client subscried to it the start sequence would be triggered
     * again since it's a cold observable.
     */
    this.hubConnection.start()
      .done(() => {
        this.startingSubject.next();
      })
      .fail((error: any) => {
        this.startingSubject.error(error);
      })
    ;
  }

  /**
   * Get an observable that will contain the data associated with a specific
   * channel
   */
  sub(channel: string): Observable<ChannelEvent> {
    // Try to find an observable that we already created for the requested channel
    //noinspection TypeScriptUnresolvedFunction
    let channelSub = this.subjects.find((x: ChannelSubject) => {
      return x.channel === channel;
    }) as ChannelSubject;

    // If we already have one for this event, then just return it
    if (channelSub !== undefined) {
      console.log(`Found existing observable for ${channel} channel`);

      return channelSub.subject.asObservable();
    }

    /**
     * If we're here then we don't already have the observable to provide the
     * caller, so we need to call the server method to join the channel
     * and then create an observable that the caller can use to received
     * messages.
     *
     *
     * Now we just create our internal object so we can track this subject
     * in case someone else wants it too
     */
    channelSub = new ChannelSubject();
    channelSub.channel = channel;
    channelSub.subject = new Subject<ChannelEvent>();

    this.subjects.push(channelSub);

    /**
     * Now SignalR is asynchronous, so we need to ensure the connection is
     * established before we call any server methods. So we'll subscribe to
     * the starting$ stream since that won't emit a value until the connection
     * is ready
     */
    this.starting$.subscribe(() => {
        this.hubProxy.invoke('Subscribe', channel)
          .done(() => {
            console.log(`Successfully subscribed to ${channel} channel`);
          })
          .fail((error: any) => {
            channelSub.subject.error(error);
          });
      },
      (error: any) => {
        channelSub.subject.error(error);
      });

    return channelSub.subject.asObservable();
  }

  // Not quite sure how to handle this (if at all) since there could be
  //  more than 1 caller subscribed to an observable we created
  //
  // unsubscribe(channel: string): Rx.Observable<any> {
  //     this.observables = this.observables.filter((x: ChannelObservable) => {
  //         return x.channel === channel;
  //     });
  // }

  /**
   * publish provides a way for calles to emit events on any channel. In a
   * production app the server would ensure that only authorized clients can
   * actually emit the message, but here we're not concerned about that.
   */
  publish(event: ChannelEvent): void {
    this.hubProxy.invoke('Publish', event);
  }
}
