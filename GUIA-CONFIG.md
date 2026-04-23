# Guia de configuração — Sistema Tailored

Passos pra deixar o sistema 100% funcional no GitHub Pages + Firebase. Já está tudo no código, você só precisa configurar 3 coisas no Firebase.

## 1) Estrutura de arquivos

Coloque todos estes arquivos na raiz do seu repositório `leonardodteles/franco-fragoso` (substituindo o `index.html` atual):

```
index.html              ← Tela inicial (código do cliente)
admin.html              ← Painel administrativo
obra.html               ← Página da obra (cronograma)
modelo-atividades.xlsx  ← Modelo de planilha pra importar
GUIA-CONFIG.md          ← Este guia
```

## 2) Configurar regras do Realtime Database

No [console Firebase](https://console.firebase.google.com/) → seu projeto → **Realtime Database → Regras**, cole:

```json
{
  "rules": {
    "codes": {
      ".read": true,
      ".write": "auth != null"
    },
    "obras": {
      ".read": true,
      ".write": "auth != null"
    },
    "tasks": {
      ".read": true,
      ".write": "auth != null"
    },
    "progress": {
      ".read": true,
      ".write": true
    },
    "meta": {
      ".read": true,
      ".write": true
    }
  }
}
```

**O que essas regras fazem:**
- Qualquer cliente com o código pode **ler** obras, tarefas e marcar progresso
- **Só admins logados** podem criar/editar obras e importar planilhas
- O `progress` é aberto pra escrita porque é como o cliente marca o avanço (sem login). Se quiser mais segurança depois, dá pra refinar.

Clique em **Publicar**.

## 3) Ativar login por email/senha

No console Firebase → **Authentication → Sign-in method** → habilite **Email/Password**.

Depois vá em **Users** e clique em **Adicionar usuário**. Crie uma conta pra cada pessoa da equipe Tailored que vai acessar o admin. Exemplo:
- `leonardo@tailored.eng.br` / senha forte
- `adm@tailored.eng.br` / senha forte

## 4) Como usar

### Primeira vez

1. Suba os arquivos pro GitHub (push).
2. Abra `https://leonardodteles.github.io/franco-fragoso/`.
3. Clique em **Acesso administrativo** → faça login com o email criado no passo 3.
4. Clique em **Nova obra**:
   - Nome: `Escritório Franco & Fragoso — Obra Nova`
   - Cliente: `Franco & Fragoso Advocacia`
   - Código: `FF-2026`
   - Data início / fim do cronograma
5. Clique em **Baixar modelo de planilha** (botão no topo do admin).
6. Preencha as atividades no Excel.
7. Na linha da obra, clique no ícone de upload (seta pra cima) → arraste a planilha → confirme.
8. Pronto: acesse `https://leonardodteles.github.io/franco-fragoso/?code=FF-2026` (ou digite o código na tela inicial) pra ver a obra.

### Fluxo do cliente

1. Recebe o link (ou abre a página e digita o código `FF-2026`).
2. Vê o cronograma dele com barra de progresso, KPIs, linha do tempo.
3. Clica nas atividades pra marcar status (Pendente → Em Andamento → Concluído).
4. O progresso sincroniza em tempo real entre todos os dispositivos.

### Fluxo do admin

- **Lista de obras** com buscador, estatísticas no topo.
- **Nova obra / Editar / Excluir.**
- **Importar planilha** por obra (substitui as atividades — o progresso dos IDs iguais é preservado).
- **Desativar um código** sem perder a obra (em Editar → Status).
- **Ver obra** abre a mesma página do cliente numa nova aba com badge "Modo admin".

## 5) Formato da planilha

A planilha **modelo-atividades.xlsx** já vem com 21 atividades de exemplo (as mesmas da obra Franco & Fragoso) e validações nas colunas. Campos:

| Coluna | Obrigatório | Notas |
|---|---|---|
| ID | Não | Se vazio, sistema gera (t001, t002…). Se repetir, sobrescreve. |
| Fase | Sim | `PROJETOS` ou `OBRA` |
| Atividade | Sim | Nome exibido no Gantt |
| Departamento | Não | Cada departamento ganha cor automática |
| Data Início | Sim | Formato dd/mm/aaaa |
| Data Fim | Sim | Formato dd/mm/aaaa |
| Dias | Não | Calculado automaticamente |
| Crítica | Não | `Sim`/`Não` — marca caminho crítico |

## 6) Estrutura dos dados no Firebase

Pra referência futura:

```
codes/
  FF-2026/ { obraId: "obra_xyz", ativo: true }
  JK-001/  { obraId: "obra_abc", ativo: true }

obras/
  obra_xyz/ { nome, cliente, code, start, end, sub, updatedAt }

tasks/
  obra_xyz/
    definition/
      t01/ { phase, name, dept, start, end, days, critical, order }
      t02/ { ... }
    updatedAt: 1234567890

progress/
  obra_xyz/
    t01: "done"
    t02: "progress"

meta/
  obra_xyz/ { lastUpdate: 1234567890 }
```

## 7) Troubleshooting

**"Email ou senha incorretos" no login** — Confira que o usuário existe em Authentication → Users. Senhas têm que ter 6+ caracteres.

**"Login por email/senha não está habilitado"** — Volte no passo 3 e ative o provedor.

**Cliente digita o código e recebe "Código não encontrado"** — Confira se o código na obra bate com o que está em `codes/`. Em Editar obra, o código é normalizado pra maiúsculas sem espaços.

**Obra importada mas cronograma vazio** — Confira que a aba da planilha se chama "Atividades" e que as colunas estão com os nomes corretos.
