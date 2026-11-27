/**
 * The compiled transmux on the main thread: one instance for the transmux
 * that runs here when no Worker starts, and for the modules the main thread
 * shares with it (the list is in rolldown.config.mjs).
 */
import transmuxModule from 'virtual:transmux-module';

export const instance = transmuxModule();
