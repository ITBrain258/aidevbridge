//! Terminalausgabe eines PTY-Kanals, auch die vor der Uebergabe des Handles,
//! unter SSH-Flusskontrolle: Der Kanal kuendigt `WINDOW` an und bekommt Bytes
//! erst zurueck, wenn sein Leser sie entnimmt; liest niemand, steht die
//! Gegenseite. Jeder Kanal hat seine eigene Warteschlange.
//!
//! Faellt der Empfaenger weg, verwirft die Warteschlange, was noch anliegt,
//! ohne es dem Fenster gutzuschreiben. Steht die Gegenseite dann schon an der
//! Fenstergrenze, kommt kein Paket mehr, und der Besitzer erfaehrt vom Wegfall
//! nur ueber `request_close`. Wer den Empfaenger fallen laesst, muss den Kanal
//! deshalb immer schliessen; alle Produktionspfade tun das.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// Empfangsfenster jedes Terminalkanals (manuelles Fenster im lokalen
/// russh-Patch, `vendor/russh/AGENTBRIDGE-PATCH.md`). Obergrenze: acht
/// Terminals einer Verbindung mal Fenster bleiben unter dem, was russh bei
/// einem selbst begonnenen Schluesselwechsel an Daten unterwegs duldet
/// (`2 * client::Config::window_size` = 4 MiB, sonst `Error::Pending` und die
/// ganze Verbindung endet). Untergrenze: das Frontend bestaetigte eine
/// geflutete Kachel mit etwa 0,8 MB/s (Lastmessung 21.10.); 384 KiB tragen
/// das bis rund 480 ms Umlaufzeit. Kleiner ist besser fuer die Wartezeit
/// nach Ctrl+C: hoechstens ein Fenster liegt hier noch an.
pub(super) const WINDOW: u32 = 384 * 1024;
/// Groesste Nutzlast eines Pakets: die `maximum_packet_size`, die dieser
/// Client ankuendigt (russh-Vorgabe).
pub(super) const MAX_PACKET: usize = 32 * 1024;
/// Platz je Kanal: das ganze Fenster und ein Paket. Eine Gegenseite, die ihr
/// Fenster einhaelt, fuellt ihn nie; nur eine, die es bricht, beendet den
/// Kanal mit `OutputLimit`.
pub(super) const OUTPUT_LIMIT: usize = WINDOW as usize + MAX_PACKET;
/// Kleine Pakete wachsen in das letzte wartende Stueck hinein, bis es so gross
/// ist; groesser als ein Paket wird so kein Ereignis an das Frontend.
const CHUNK: usize = MAX_PACKET;
/// Zwei benachbarte Stuecke halten zusammen mehr als `CHUNK` Bytes, also
/// passen `OUTPUT_LIMIT` Bytes immer in so viele Stuecke.
pub(super) const FORWARD_CAPACITY: usize = 2 * OUTPUT_LIMIT / CHUNK + 1;

struct Queue {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    sender: bool,
    receiver: bool,
}

struct Shared {
    queue: Mutex<Queue>,
    ready: Notify,
    /// Gibt verbrauchte Bytes an das Kanalfenster zurueck; blockiert nie.
    credit: Box<dyn Fn(usize) + Send + Sync>,
}

/// Ausgabe Byte fuer Byte. Bytes gehen beim tatsaechlichen Entnehmen an das
/// Kanalfenster zurueck, nicht beim Eintreffen.
pub struct PtyOutputReceiver(Arc<Shared>);

impl PtyOutputReceiver {
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        loop {
            {
                let mut queue = self.0.queue.lock().unwrap();
                if let Some(chunk) = queue.chunks.pop_front() {
                    queue.bytes -= chunk.len();
                    drop(queue);
                    (self.0.credit)(chunk.len());
                    return Some(chunk);
                }
                if !queue.sender {
                    return None;
                }
            }
            self.0.ready.notified().await;
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.queue.lock().unwrap().chunks.len()
    }

    #[cfg(test)]
    pub(crate) fn queued_bytes(&self) -> usize {
        self.0.queue.lock().unwrap().bytes
    }

    pub(super) fn empty() -> Self {
        let (output, receiver) = channel(|_| {});
        drop(output);
        receiver
    }
}

impl Drop for PtyOutputReceiver {
    fn drop(&mut self) {
        let mut queue = self.0.queue.lock().unwrap();
        queue.receiver = false;
        queue.chunks.clear();
        queue.bytes = 0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PushError {
    Limit,
    Closed,
}

pub(super) struct Output(Arc<Shared>);

pub(super) fn channel(
    credit: impl Fn(usize) + Send + Sync + 'static,
) -> (Output, PtyOutputReceiver) {
    let shared = Arc::new(Shared {
        queue: Mutex::new(Queue {
            chunks: VecDeque::new(),
            bytes: 0,
            sender: true,
            receiver: true,
        }),
        ready: Notify::new(),
        credit: Box::new(credit),
    });
    (Output(shared.clone()), PtyOutputReceiver(shared))
}

impl Output {
    /// Wartet nie. Unter Flusskontrolle ist die Warteschlange nur voll, wenn
    /// die Gegenseite ihr Fenster gebrochen hat; dann `Limit`.
    pub(super) fn push(&self, data: &[u8]) -> Result<(), PushError> {
        let mut queue = self.0.queue.lock().unwrap();
        if !queue.receiver {
            return Err(PushError::Closed);
        }
        if data.is_empty() {
            return Ok(());
        }
        if queue.bytes + data.len() > OUTPUT_LIMIT {
            return Err(PushError::Limit);
        }
        match queue.chunks.back_mut() {
            Some(last) if last.len() + data.len() <= CHUNK => last.extend_from_slice(data),
            _ => {
                if queue.chunks.len() >= FORWARD_CAPACITY {
                    return Err(PushError::Limit);
                }
                queue.chunks.push_back(data.to_vec());
            }
        }
        queue.bytes += data.len();
        drop(queue);
        self.0.ready.notify_one();
        Ok(())
    }

    /// Bytes, die der Besitzer selbst verbraucht, ohne sie einzureihen (die
    /// W-Zeile des Attach-Wrappers), gehen sofort an das Kanalfenster zurueck.
    pub(super) fn consumed(&self, bytes: usize) {
        (self.0.credit)(bytes);
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        self.0.queue.lock().unwrap().sender = false;
        self.0.ready.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn recorded() -> (Output, PtyOutputReceiver, Arc<AtomicUsize>) {
        let credited = Arc::new(AtomicUsize::new(0));
        let sink = credited.clone();
        let (output, receiver) = channel(move |bytes| {
            sink.fetch_add(bytes, Ordering::SeqCst);
        });
        (output, receiver, credited)
    }

    #[tokio::test]
    async fn tiny_packets_join_one_chunk_and_return_credit_only_on_extraction() {
        let (output, mut receiver, credited) = recorded();
        for _ in 0..10000 {
            output.push(&[]).unwrap();
        }
        assert_eq!(receiver.len(), 0);
        for byte in 0..64u8 {
            output.push(&[byte]).unwrap();
        }
        assert_eq!(receiver.len(), 1, "64 tiny packets take one slot");
        assert_eq!(
            credited.load(Ordering::SeqCst),
            0,
            "arrival credits nothing"
        );
        assert_eq!(receiver.recv().await, Some((0..64u8).collect::<Vec<_>>()));
        assert_eq!(credited.load(Ordering::SeqCst), 64);
        output.push(&[99]).unwrap();
        drop(output);
        assert_eq!(receiver.recv().await, Some(vec![99]));
        assert_eq!(receiver.recv().await, None);
        assert_eq!(credited.load(Ordering::SeqCst), 65);
    }

    #[tokio::test]
    async fn chunks_stay_within_one_packet_and_keep_byte_order() {
        let (output, mut receiver, _) = recorded();
        let mut sent = Vec::new();
        for (index, len) in [7_000, 20_000, 9_000, MAX_PACKET, 1, 31_000, 3]
            .iter()
            .enumerate()
        {
            let packet = vec![index as u8; *len];
            output.push(&packet).unwrap();
            sent.extend_from_slice(&packet);
        }
        drop(output);
        let mut seen = Vec::new();
        while let Some(chunk) = receiver.recv().await {
            assert!(
                chunk.len() <= MAX_PACKET,
                "{} bytes in one chunk",
                chunk.len()
            );
            seen.extend_from_slice(&chunk);
        }
        assert_eq!(seen, sent);
    }

    #[tokio::test]
    async fn byte_limit_allows_a_window_and_one_packet_and_recovers_on_extraction() {
        let (output, mut receiver, credited) = recorded();
        assert_eq!(
            output.push(&vec![0; OUTPUT_LIMIT + 1]),
            Err(PushError::Limit)
        );
        output.push(&vec![0xff; OUTPUT_LIMIT]).unwrap();
        for _ in 0..FORWARD_CAPACITY * 2 {
            assert_eq!(output.push(&[1]), Err(PushError::Limit));
        }
        assert_eq!((receiver.len(), receiver.queued_bytes()), (1, OUTPUT_LIMIT));
        assert_eq!(receiver.recv().await.unwrap(), vec![0xff; OUTPUT_LIMIT]);
        assert_eq!(credited.load(Ordering::SeqCst), OUTPUT_LIMIT);
        assert_eq!(receiver.queued_bytes(), 0);
        output.push(&[1]).unwrap();
    }

    /// Die Slots reichen fuer jede Paketfolge, die das Byte-Budget einhaelt:
    /// `Limit` kommt nur, wenn das naechste Paket mehr als `OUTPUT_LIMIT`
    /// Bytes ergaebe, auch im unguenstigsten Wechsel aus vollen und winzigen
    /// Paketen.
    #[test]
    fn slots_never_run_out_before_the_byte_limit() {
        let half = CHUNK / 2 + 1;
        for pattern in [
            vec![MAX_PACKET, 1],
            vec![half],
            vec![1],
            vec![CHUNK - 1, 2],
            vec![MAX_PACKET],
            vec![half, 1, MAX_PACKET],
        ] {
            let (output, receiver, _) = recorded();
            for len in pattern.iter().cycle() {
                match output.push(&vec![7; *len]) {
                    Ok(()) => assert!(receiver.len() <= FORWARD_CAPACITY),
                    Err(error) => {
                        assert_eq!(error, PushError::Limit);
                        assert!(
                            receiver.queued_bytes() + len > OUTPUT_LIMIT,
                            "{pattern:?}: slots ran out at {} bytes",
                            receiver.queued_bytes()
                        );
                        break;
                    }
                }
            }
        }
    }

    #[test]
    fn max_packet_is_what_the_client_advertises() {
        assert_eq!(
            MAX_PACKET as u32,
            russh::client::Config::default().maximum_packet_size
        );
    }

    #[tokio::test]
    async fn delayed_receiver_preserves_all_tail_bytes_after_sender_end() {
        let (output, mut receiver, _) = recorded();
        output.push(&[0, 0xff, b'\r']).unwrap();
        output.push(&[0xc3, 0x28, b'\n']).unwrap();
        drop(output);
        assert_eq!(
            receiver.recv().await,
            Some(vec![0, 0xff, b'\r', 0xc3, 0x28, b'\n'])
        );
        assert_eq!(receiver.recv().await, None);
    }

    #[test]
    fn receiver_drop_discards_without_credit_and_closes_admission() {
        let (output, receiver, credited) = recorded();
        output.push(&vec![4; OUTPUT_LIMIT]).unwrap();
        drop(receiver);
        assert_eq!(output.push(&[1]), Err(PushError::Closed));
        assert_eq!(output.0.queue.lock().unwrap().bytes, 0);
        assert_eq!(credited.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn consumed_bytes_return_to_the_window_without_queueing() {
        let (output, receiver, credited) = recorded();
        output.consumed(70);
        assert_eq!((receiver.len(), credited.load(Ordering::SeqCst)), (0, 70));
    }
}
