import 'dart:async';

import 'package:buzz/shared/relay/relay.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  test('hung handshake times out, closes, and reports disconnection', () async {
    final channel = _HungWebSocketChannel();
    final disconnected = Completer<Object?>();
    final socket = RelaySocket(
      wsUrl: 'wss://relay.example',
      nsec: null,
      onMessage: (_) {},
      onConnected: () => fail('socket must not connect'),
      onDisconnected: disconnected.complete,
      channelFactory: (_) => channel,
      connectTimeout: const Duration(milliseconds: 1),
    );

    await socket.connect();

    expect(await disconnected.future, isA<TimeoutException>());
    expect(socket.state, SocketState.disconnected);
    expect(channel.closeCount, 1);
  });
}

class _HungWebSocketChannel implements WebSocketChannel {
  final _controller = StreamController<dynamic>();
  final _ready = Completer<void>();
  int closeCount = 0;

  @override
  Future<void> get ready => _ready.future;

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Stream<dynamic> get stream => _controller.stream;

  @override
  late final WebSocketSink sink = _RecordingWebSocketSink(
    _controller.sink,
    () => closeCount++,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _RecordingWebSocketSink implements WebSocketSink {
  final void Function() onClose;

  _RecordingWebSocketSink(StreamSink<dynamic> sink, this.onClose);

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    onClose();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
