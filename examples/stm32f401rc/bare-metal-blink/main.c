#include <stdint.h>

#define RCC_BASE 0x40023800U
#define RCC_AHB1ENR (*(volatile uint32_t *)(RCC_BASE + 0x30U))

#define GPIOC_BASE 0x40020800U
#define GPIOC_MODER (*(volatile uint32_t *)(GPIOC_BASE + 0x00U))
#define GPIOC_BSRR (*(volatile uint32_t *)(GPIOC_BASE + 0x18U))

#define LED_PIN 13U

static void delay(volatile uint32_t count)
{
    while (count--) {
        __asm__ volatile ("nop");
    }
}

int main(void)
{
    RCC_AHB1ENR |= (1U << 2);
    GPIOC_MODER &= ~(3U << (LED_PIN * 2U));
    GPIOC_MODER |= (1U << (LED_PIN * 2U));

    for (;;) {
        GPIOC_BSRR = (1U << (LED_PIN + 16U));
        delay(400000U);
        GPIOC_BSRR = (1U << LED_PIN);
        delay(400000U);
    }
}

void _start(void)
{
    main();
}
