import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:buzz/features/pairing/pairing_socket.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'connect completes when pairing relay does not request auth',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);

      final sockets = <WebSocket>[];
      server.listen((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        sockets.add(socket);
        addTearDown(socket.close);
        await for (final _ in socket) {
          // This relay intentionally never sends AUTH.
        }
      });

      final socket = PairingSocket(
        wsUrl: 'ws://${server.address.host}:${server.port}',
        ephemeralPrivkey: '1' * 64,
        onMessage: (_) {},
        onDisconnected: (_) {},
      );
      addTearDown(socket.dispose);

      await socket.connect();

      expect(socket.isConnected, isTrue);
      expect(sockets, hasLength(1));
    },
    timeout: const Timeout(Duration(seconds: 5)),
  );

  test(
    'answers auth when relay requests NIP-42',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(server.close);

      final receivedAuth = Completer<List<dynamic>>();
      server.listen((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        addTearDown(socket.close);
        socket.add(jsonEncode(['AUTH', 'challenge']));
        await for (final raw in socket) {
          final message = jsonDecode(raw as String) as List<dynamic>;
          if (message.first == 'AUTH') {
            receivedAuth.complete(message);
            final event = message[1] as Map<String, dynamic>;
            socket.add(jsonEncode(['OK', event['id'], true, '']));
          }
        }
      });

      final socket = PairingSocket(
        wsUrl: 'ws://${server.address.host}:${server.port}',
        ephemeralPrivkey: '1' * 64,
        onMessage: (_) {},
        onDisconnected: (_) {},
      );
      addTearDown(socket.dispose);

      await socket.connect();

      expect(socket.isConnected, isTrue);
      final auth = await receivedAuth.future;
      expect(auth.first, 'AUTH');
      final event = auth[1] as Map<String, dynamic>;
      expect(event['kind'], 22242);
      expect(
        event['tags'],
        contains(
          predicate<List<dynamic>>(
            (tag) =>
                tag.length == 2 &&
                tag[0] == 'challenge' &&
                tag[1] == 'challenge',
          ),
        ),
      );
    },
    timeout: const Timeout(Duration(seconds: 5)),
  );
}
