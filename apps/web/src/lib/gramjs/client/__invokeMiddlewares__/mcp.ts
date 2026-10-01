import type TelegramClient from '../MockClient';

import readStrings from '../../../../util/data/readStrings';
import Api from '../../tl/api';
import createMockedUser from '../mockUtils/createMockedUser';
import getIdFromInputPeer from '../mockUtils/getIdFromInputPeer';

import fallback from '../../../../assets/localization/fallback.strings?raw';

// This scenario is loaded only by the mocked Telegram transport in browser tests
export default async function invokeMcpFixture(client: TelegramClient, request: object) {
  await Promise.resolve();
  if (request instanceof Api.auth.AcceptLoginToken) {
    const response = await fetch('/__fixture__/accept-token', { method: 'POST' });
    return response.ok ? true : undefined;
  }
  if (request instanceof Api.messages.GetDialogFilters) {
    return new Api.messages.DialogFilters({ filters: [new Api.DialogFilterDefault()] });
  }
  if (request instanceof Api.langpack.GetLanguage) {
    return new Api.LangPackLanguage({
      langCode: 'en',
      name: 'English',
      nativeName: 'English',
      pluralCode: 'en',
      stringsCount: 1,
      translatedCount: 1,
      translationsUrl: 'https://translations.telegram.org/en/weba',
    });
  }
  if (request instanceof Api.langpack.GetLangPack || request instanceof Api.langpack.GetDifference) {
    return new Api.LangPackDifference({
      langCode: 'en',
      fromVersion: 0,
      version: 1,
      strings: Object.entries(readStrings(fallback)).map(
        ([key, value]) => new Api.LangPackString({ key, value }),
      ),
    });
  }
  if (request instanceof Api.updates.GetState) {
    return new Api.updates.State({ pts: 1, qts: 0, seq: 1, date: 1700000000, unreadCount: 0 });
  }
  if (request instanceof Api.updates.GetDifference) {
    return new Api.updates.DifferenceEmpty({ date: 1700000000, seq: 1 });
  }
  if (request instanceof Api.users.GetFullUser) {
    return new Api.users.UserFull({
      fullUser: new Api.UserFull({
        id: 1n,
        about: 'Browser test fixture',
        commonChatsCount: 0,
        settings: new Api.PeerSettings({}),
        notifySettings: new Api.PeerNotifySettings({}),
      }),
      chats: [],
      users: [createMockedUser('1', client.mockData)],
    });
  }
  if (request instanceof Api.messages.SendMessage) {
    const peerId = getIdFromInputPeer(request.peer);
    const id = client.mockData.messages[peerId].length + 100;
    client.mockData.messages[peerId].push({ id, message: request.message, out: true });
    return new Api.UpdateShortSentMessage({ id, pts: id, ptsCount: 1, date: 1700000100, out: true });
  }
  return 'pass';
}
